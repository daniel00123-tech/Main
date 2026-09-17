"""Read-only Aquilo JobWatch (legacy webservice) client.

Never writes to BigChange. Credentials and cache stay on the Aquilo path.
"""

from __future__ import annotations

import base64
import datetime as dt
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from .settings import AquiloSettings, HISTORY_ANCHOR, LONDON
from .util import (
    as_decimal,
    as_int,
    chunk_dates,
    compact_key,
    daterange,
    first_present,
    is_populated,
    nested_rows,
    parse_date,
)

INVOICE_TYPES = {"invoice", "salesinvoice", "si"}
CREDIT_TYPES = {"credit", "creditnote", "cn", "credit note"}
PO_TYPES = {"purchaseorder", "po", "purchase", "purchase order"}
QUOTE_TYPES = {"quote", "quotation", "qt"}
DATE_FIELDS = ("DocumentDate", "InvoiceDate", "OrderDate", "DocDate", "TaxDate", "Date")
DOC_ID_FIELDS = ("DocumentId", "DocId", "InvoiceId", "Id", "FinancialDocumentId")
LINE_KEYS = {
    "financiallines",
    "financialline",
    "financialdoclines",
    "financialdocline",
    "invoicelines",
    "invoiceline",
    "lines",
    "lineitems",
    "items",
}


class JobWatchError(RuntimeError):
    pass


class AquiloJobWatchClient:
    """Legacy services.ashx client bound to Aquilo settings only."""

    def __init__(self, settings: AquiloSettings, timeout: int = 180) -> None:
        self.settings = settings
        token = base64.b64encode(f"{settings.username}:{settings.password}".encode("utf-8")).decode("ascii")
        self.headers = {
            "Authorization": f"Basic {token}",
            "key": settings.api_key,
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        self.timeout = timeout
        self.base_url = settings.base_url.rstrip("/")

    def get(self, action: str, params: dict[str, Any] | None = None, attempts: int = 3) -> dict[str, Any]:
        query = {"action": action}
        if params:
            query.update({k: str(v) for k, v in params.items() if v is not None and v != ""})
        url = f"{self.base_url}?{urllib.parse.urlencode(query)}"
        req = urllib.request.Request(url, headers=self.headers)
        last_error: Exception | None = None
        for attempt in range(attempts):
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as response:
                    raw = response.read()
                payload = json.loads(raw.decode("utf-8-sig"))
                if not isinstance(payload, dict):
                    raise JobWatchError(f"Unexpected response for {action}")
                return payload
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
                last_error = exc
                if attempt == attempts - 1:
                    break
                time.sleep(2**attempt)
        raise JobWatchError(f"Aquilo JobWatch {action} failed: {type(last_error).__name__}")

    @staticmethod
    def ok(payload: dict[str, Any]) -> bool:
        return payload.get("Code") in (None, "", 0, "0")

    def result_rows(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        result = payload.get("Result")
        if isinstance(result, dict):
            for key in ("InvoicesList", "InvoiceList", "Invoices", "Documents", "Jobs", "JobList"):
                if key in result:
                    rows = nested_rows(result[key])
                    if rows:
                        return rows
        rows = nested_rows(result)
        if rows:
            return rows
        return nested_rows(payload)

    def jobs_window(
        self,
        start: dt.date,
        end_inclusive: dt.date,
        page_size: int = 500,
        date_option_id: int = 2,
    ) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        page = 0
        while True:
            payload = self.get(
                "JobsList",
                {
                    "Start": start.isoformat(),
                    "End": (end_inclusive + dt.timedelta(days=1)).isoformat(),
                    "DateOptionId": date_option_id,
                    "Page": page,
                    "PageSize": page_size,
                },
            )
            if not self.ok(payload):
                raise JobWatchError(f"JobsList failed Code={payload.get('Code')}")
            batch = self.result_rows(payload)
            rows.extend(batch)
            if len(batch) < page_size:
                return rows
            page += 1
            if page > 200:
                raise JobWatchError("JobsList pagination exceeded safety limit")

    def job(self, job_id: str | int) -> dict[str, Any] | None:
        payload = self.get("Job", {"JobId": str(job_id)}, attempts=2)
        if not self.ok(payload):
            return None
        result = payload.get("Result")
        if isinstance(result, dict) and result.get("JobId") not in (None, ""):
            return result
        rows = self.result_rows(payload)
        return rows[0] if rows else None

    def invoices_window(self, start: dt.date, end_exclusive: dt.date) -> list[dict[str, Any]]:
        """Start inclusive, End exclusive. Always request Unsent as well."""
        params = {
            "Start": start.isoformat(),
            "End": end_exclusive.isoformat(),
            "IncludeUnsent": 1,
        }
        payload = self.get("InvoicesWithItemsByPeriod", params)
        if not self.ok(payload):
            params.pop("IncludeUnsent", None)
            payload = self.get("InvoicesWithItemsByPeriod", params)
        if not self.ok(payload):
            raise JobWatchError(f"InvoicesWithItemsByPeriod failed Code={payload.get('Code')}")
        return extract_documents(payload)

    def resources(self) -> list[dict[str, Any]]:
        for action in ("Resources", "ResourceList"):
            try:
                payload = self.get(action, attempts=2)
            except JobWatchError:
                continue
            if self.ok(payload):
                rows = self.result_rows(payload)
                if rows:
                    return rows
        return []


def extract_documents(payload: dict[str, Any]) -> list[dict[str, Any]]:
    result = payload.get("Result")
    if isinstance(result, dict):
        for key in ("InvoicesList", "InvoiceList", "Invoices", "Documents"):
            if key in result:
                rows = nested_rows(result[key])
                if rows:
                    return rows
    rows = nested_rows(result)
    if rows:
        return rows
    return nested_rows(payload)


def extract_lines(document: dict[str, Any]) -> list[dict[str, Any]]:
    for key, value in document.items():
        if compact_key(str(key)) in LINE_KEYS:
            rows = nested_rows(value)
            if rows:
                return rows
    for value in document.values():
        if isinstance(value, dict):
            rows = extract_lines(value)
            if rows:
                return rows
    if first_present(document, ("UnitPrice", "CostPrice", "NetPrice")) not in (None, ""):
        return [document]
    return []


def classify_doc(document: dict[str, Any]) -> str | None:
    raw = first_present(document, ("OrderType", "DocumentType", "Type", "InvoiceType", "DocType"))
    text = compact_key(str(raw or ""))
    if not text:
        return None
    if text in {compact_key(x) for x in QUOTE_TYPES} or text.startswith("quote"):
        return "quote"
    if text in {compact_key(x) for x in CREDIT_TYPES} or "credit" in text:
        return "credit"
    if text in {compact_key(x) for x in PO_TYPES} or text.startswith("purchase"):
        return "po"
    if text in {compact_key(x) for x in INVOICE_TYPES} or text.startswith("invoice"):
        return "invoice"
    return None


def document_is_dropped(document: dict[str, Any]) -> bool:
    return any(
        is_populated(first_present(document, names))
        for names in (
            ("CancellationDate", "CancelledDate", "Cancelled", "IsCancelled"),
            ("DeletionDate", "DeletedDate", "Deleted", "IsDeleted"),
            ("RejectionDate", "RejectedDate", "Rejected", "IsRejected"),
        )
    )


def document_id(document: dict[str, Any]) -> str:
    value = first_present(document, DOC_ID_FIELDS)
    return str(value).strip() if value not in (None, "") else ""


def document_job_id(document: dict[str, Any]) -> int | None:
    return as_int(first_present(document, ("JobId", "JobID", "LinkedJobId", "LinkedJobID")))


def document_date(document: dict[str, Any]) -> dt.date | None:
    return parse_date(first_present(document, DATE_FIELDS), LONDON)


def line_net(line: dict[str, Any], kind: str) -> Any:
    qty = as_decimal(first_present(line, ("LineQuantity", "Quantity", "Qty")))
    if first_present(line, ("LineQuantity", "Quantity", "Qty")) in (None, ""):
        qty = as_decimal("1")
    if kind in {"invoice", "credit"}:
        unit = as_decimal(first_present(line, ("UnitPrice", "UnitSellingPrice")))
        discount = as_decimal(first_present(line, ("UnitDiscount", "Discount", "LineDiscount")))
        return (unit - discount) * qty
    cost = as_decimal(first_present(line, ("CostPrice", "UnitCost", "DefaultCost")))
    unit = as_decimal(first_present(line, ("UnitPrice",)))
    return (cost if cost != 0 else unit) * qty


def document_net(document: dict[str, Any], kind: str) -> Any:
    lines = extract_lines(document)
    if not lines:
        return as_decimal(0)
    return sum((line_net(line, kind) for line in lines), as_decimal(0))


def normalize_document(document: dict[str, Any]) -> dict[str, Any] | None:
    if document_is_dropped(document):
        return None
    kind = classify_doc(document)
    if kind is None or kind == "quote":
        return None
    when = document_date(document)
    return {
        "document_id": document_id(document),
        "job_id": document_job_id(document),
        "kind": kind,
        "document_date": when,
        "net_ex_vat": document_net(document, kind),
        "raw": document,
    }


def fetch_jobs_history(client: AquiloJobWatchClient, today: dt.date) -> list[dict[str, Any]]:
    jobs: list[dict[str, Any]] = []
    seen: set[str] = set()
    # DateOptionId 2 = PlannedStart (spec window). DateOptionId 0 catches
    # members that have no planned start so group completion is not under-counted.
    for date_option in (2, 0):
        for start, end in chunk_dates(HISTORY_ANCHOR, today, 14):
            for job in client.jobs_window(start, end, date_option_id=date_option):
                jid = str(first_present(job, ("JobId", "Id")) or "")
                key = jid or json.dumps(job, default=str)[:120]
                if key in seen:
                    continue
                seen.add(key)
                jobs.append(job)
    return jobs


def _docs_by_day(docs: list[dict[str, Any]]) -> dict[dt.date, int]:
    counts: dict[dt.date, int] = defaultdict(int)
    for doc in docs:
        when = document_date(doc)
        if when:
            counts[when] += 1
    return counts


def fetch_finance_history(client: AquiloJobWatchClient, today: dt.date) -> list[dict[str, Any]]:
    """Live finance from history anchor through today. End is exclusive. Gap-fill empty days."""
    collected: list[dict[str, Any]] = []
    seen: set[str] = set()

    def absorb(docs: list[dict[str, Any]]) -> None:
        for doc in docs:
            key = document_id(doc) or json.dumps(doc, default=str)[:160]
            if key in seen:
                continue
            seen.add(key)
            collected.append(doc)

    for start, end in chunk_dates(HISTORY_ANCHOR, today, 7):
        absorb(client.invoices_window(start, end + dt.timedelta(days=1)))

    counts = _docs_by_day(collected)
    quiet_days = [day for day in daterange(HISTORY_ANCHOR, today) if counts.get(day, 0) == 0]
    if quiet_days:
        with ThreadPoolExecutor(max_workers=6) as pool:
            filled = list(
                pool.map(
                    lambda day: client.invoices_window(day, day + dt.timedelta(days=1)),
                    quiet_days,
                )
            )
        for docs in filled:
            absorb(docs)

    return collected


def resource_group_map(client: AquiloJobWatchClient) -> dict[str, str]:
    """Map resource display name → Aquilo group label (Engineer / Subcontractor / …)."""
    id_to_label: dict[int, str] = {}
    try:
        payload = client.get("ResourceGroups", attempts=2)
    except JobWatchError:
        payload = {}
    if client.ok(payload):
        for row in client.result_rows(payload):
            gid = as_int(first_present(row, ("id", "Id", "ResourceGroupId")))
            label = str(first_present(row, ("label", "Name", "ResourceGroup")) or "").strip()
            if gid is not None and label:
                id_to_label[gid] = label
    mapping: dict[str, str] = {}
    for row in client.resources():
        name = str(first_present(row, ("label", "Resource", "ResourceName", "Name")) or "").strip()
        group = str(
            first_present(row, ("ResourceGroup", "ResourceGroupName", "Group", "Type", "Category")) or ""
        ).strip()
        gid = as_int(first_present(row, ("ResourceGroupId", "GroupId")))
        if not group and gid in id_to_label:
            group = id_to_label[gid]
        if name and group:
            mapping[name.lower()] = group
            mapping[compact_key(name)] = group
    return mapping
