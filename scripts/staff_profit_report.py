#!/usr/bin/env python3
"""Read-only BigChange profit rows for the staff commission report.

Never writes jobs, never calls JobUpdate, never changes categories.
"""

from __future__ import annotations

import base64
import datetime as dt
import decimal
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any
from zoneinfo import ZoneInfo

LONDON = ZoneInfo("Europe/London")
DECIMAL_ZERO = decimal.Decimal("0")
FINANCIAL_WINDOW_START = dt.date(2026, 5, 1)
CUSTOMER_ID = "5702"
REST_BASE = "https://api.bigchange.com"
INVOICE_TYPES = {"invoice", "salesinvoice", "si"}
CREDIT_TYPES = {"credit", "creditnote", "cn", "credit note"}
PO_TYPES = {"purchaseorder", "po", "purchase", "purchase order"}
QUOTE_TYPES = {"quote", "quotation", "qt"}
EXCLUDED_EMPTY = {"", "none", "null", "0", "false", "no", "n", "0001-01-01", "0001-01-01 00:00:00"}
DATE_FIELDS = ("DocumentDate", "InvoiceDate", "OrderDate", "DocDate", "TaxDate", "Date")
CANCEL_FIELD_GROUPS = (
    ("CancellationDate", "CancelledDate", "Cancelled", "IsCancelled"),
    ("DeletionDate", "DeletedDate", "Deleted", "IsDeleted"),
    ("RejectionDate", "RejectedDate", "Rejected", "IsRejected"),
)
COMPLETED_STATUSES = {"completedok", "completedwithissues", "complete", "completed"}
CANCELLED_STATUSES = {"cancelled", "canceled", "deleted", "rejected", "void"}
ANOMALY_SALE = decimal.Decimal("250")
ANOMALY_PO = decimal.Decimal("1")


class ConfigError(RuntimeError):
    pass


def required_env(name: str) -> str:
    value = os.environ.get(name)
    if value is None or value == "":
        raise ConfigError(f"Missing required environment variable: {name}")
    return value


def first_present(row: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        if key in row and row[key] not in (None, ""):
            return row[key]
    lower = {str(k).lower(): v for k, v in row.items()}
    for key in keys:
        value = lower.get(key.lower())
        if value not in (None, ""):
            return value
    return None


def compact_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def as_decimal(value: Any) -> decimal.Decimal:
    if value in (None, ""):
        return DECIMAL_ZERO
    try:
        return decimal.Decimal(str(value).replace(",", "").strip())
    except decimal.InvalidOperation:
        return DECIMAL_ZERO


def as_int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def code_is_success(payload: dict[str, Any]) -> bool:
    return payload.get("Code") in (None, "", 0, "0")


def nested_rows(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [row for row in value if isinstance(row, dict)]
    if isinstance(value, dict):
        rows: list[dict[str, Any]] = []
        for nested in value.values():
            if isinstance(nested, list):
                rows.extend(row for row in nested if isinstance(row, dict))
        if rows:
            return rows
        return [value]
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
    line_keys = {
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
    for key, value in document.items():
        if compact_key(str(key)) in line_keys:
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


def parse_document_date(value: Any) -> dt.date | None:
    if value in (None, "", "0001-01-01 00:00:00", "0001-01-01"):
        return None
    text = str(value).strip()
    if not text:
        return None
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return dt.date.fromisoformat(text)
    if re.fullmatch(r"\d{2}/\d{2}/\d{4}", text):
        return dt.datetime.strptime(text, "%d/%m/%Y").date()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2} 00:00:00", text):
        return dt.date.fromisoformat(text[:10])
    formats = [
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%d/%m/%Y %H:%M:%S",
        "%d/%m/%Y %H:%M",
    ]
    parsed: dt.datetime | None = None
    for fmt in formats:
        try:
            parsed = dt.datetime.strptime(text[:19] if "T" in text or " " in text else text, fmt)
            break
        except ValueError:
            continue
    if parsed is None:
        try:
            parsed = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(LONDON).date()


def parse_datetime(value: Any) -> dt.datetime | None:
    if value in (None, "", "0001-01-01 00:00:00", "0001-01-01"):
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        parsed = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        date = parse_document_date(value)
        if date is None:
            return None
        return dt.datetime.combine(date, dt.time.min, tzinfo=LONDON)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(LONDON)


def document_date(document: dict[str, Any]) -> dt.date | None:
    return parse_document_date(first_present(document, DATE_FIELDS))


def is_flagged(document: dict[str, Any], keys: tuple[str, ...]) -> bool:
    value = first_present(document, keys)
    if value in (None, ""):
        return False
    return str(value).strip().lower() not in EXCLUDED_EMPTY


def is_excluded_status(document: dict[str, Any]) -> bool:
    return any(is_flagged(document, keys) for keys in CANCEL_FIELD_GROUPS)


def classify_doc(document: dict[str, Any]) -> str | None:
    raw = first_present(
        document,
        ("OrderType", "DocumentType", "Type", "InvoiceType", "DocType"),
    )
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


def line_sale_amount(line: dict[str, Any]) -> decimal.Decimal:
    price = as_decimal(first_present(line, ("UnitPrice", "UnitSellingPrice")))
    qty = as_decimal(first_present(line, ("LineQuantity", "Quantity", "Qty")))
    if first_present(line, ("LineQuantity", "Quantity", "Qty")) in (None, ""):
        qty = decimal.Decimal("1")
    return price * qty


def line_po_amount(line: dict[str, Any]) -> decimal.Decimal:
    cost = as_decimal(first_present(line, ("CostPrice", "UnitCost", "DefaultCost")))
    unit = as_decimal(first_present(line, ("UnitPrice",)))
    qty = as_decimal(first_present(line, ("LineQuantity", "Quantity", "Qty")))
    if first_present(line, ("LineQuantity", "Quantity", "Qty")) in (None, ""):
        qty = decimal.Decimal("1")
    return (cost if cost != 0 else unit) * qty


def document_amount(document: dict[str, Any], kind: str) -> decimal.Decimal:
    lines = extract_lines(document)
    if not lines:
        return DECIMAL_ZERO
    if kind in {"invoice", "credit"}:
        return sum((line_sale_amount(line) for line in lines), DECIMAL_ZERO)
    return sum((line_po_amount(line) for line in lines), DECIMAL_ZERO)


def document_job_id(document: dict[str, Any]) -> str:
    value = first_present(document, ("JobId", "JobID", "LinkedJobId", "LinkedJobID"))
    return str(value).strip() if value not in (None, "") else ""


def document_group_id(document: dict[str, Any]) -> str:
    value = first_present(document, ("JobGroupId", "GroupId", "jobGroupId"))
    text = str(value).strip() if value not in (None, "") else ""
    return "" if text in {"0", "None"} else text


def london_month_bounds(today: dt.date) -> tuple[dt.date, dt.date]:
    start = today.replace(day=1)
    if start.month == 12:
        end = dt.date(start.year + 1, 1, 1) - dt.timedelta(days=1)
    else:
        end = dt.date(start.year, start.month + 1, 1) - dt.timedelta(days=1)
    return start, end


def iso_london(moment: dt.datetime) -> str:
    return moment.astimezone(LONDON).isoformat(timespec="seconds")


def chunks(values: list[str], size: int) -> list[list[str]]:
    return [values[i : i + size] for i in range(0, len(values), size)]


def job_status_text(job: dict[str, Any]) -> str:
    raw = first_present(job, ("status", "Status", "jobStatus", "JobStatus"))
    if isinstance(raw, dict):
        raw = first_present(raw, ("name", "value", "status", "code"))
    return compact_key(str(raw or ""))


def job_is_cancelled(job: dict[str, Any]) -> bool:
    status = job_status_text(job)
    if status in CANCELLED_STATUSES or status.startswith("cancel"):
        return True
    return any(is_flagged(job, keys) for keys in CANCEL_FIELD_GROUPS)


def job_is_completed(job: dict[str, Any]) -> bool:
    status = job_status_text(job)
    return status in COMPLETED_STATUSES or status.startswith("completed")


def job_id_of(job: dict[str, Any]) -> str:
    value = first_present(job, ("id", "Id", "ID", "jobId", "JobId"))
    return str(value).strip() if value not in (None, "") else ""


def job_created_at(job: dict[str, Any]) -> dt.datetime:
    parsed = parse_datetime(first_present(job, ("createdAt", "CreatedAt", "created", "Created", "DateCreated")))
    return parsed or dt.datetime.max.replace(tzinfo=LONDON)


def job_category_id(job: dict[str, Any]) -> str:
    nested = first_present(job, ("category", "Category", "jobCategory", "JobCategory"))
    if isinstance(nested, dict):
        value = first_present(nested, ("id", "Id", "ID", "categoryId"))
        if value not in (None, ""):
            return str(value).strip()
    value = first_present(job, ("categoryId", "CategoryId", "jobCategoryId", "JobCategoryId"))
    return str(value).strip() if value not in (None, "") else ""


def job_group_id(job: dict[str, Any]) -> str:
    nested = first_present(job, ("jobGroup", "JobGroup", "group", "Group"))
    if isinstance(nested, dict):
        value = first_present(nested, ("id", "Id", "ID", "jobGroupId"))
        if value not in (None, ""):
            return str(value).strip()
    value = first_present(job, ("jobGroupId", "JobGroupId", "groupId", "GroupId"))
    return str(value).strip() if value not in (None, "") else ""


def job_group_ref_hint(job: dict[str, Any]) -> str:
    nested = first_present(job, ("jobGroup", "JobGroup", "group", "Group"))
    if isinstance(nested, dict):
        value = first_present(nested, ("reference", "Reference", "jobGroupReference", "JobGroupReference"))
        if value not in (None, ""):
            return str(value).strip()
    value = first_present(job, ("jobGroupReference", "JobGroupReference", "groupReference", "GroupReference"))
    return str(value).strip() if value not in (None, "") else ""


def job_display_label(job: dict[str, Any]) -> str:
    value = first_present(job, ("orderNumber", "OrderNumber", "reference", "Reference", "jobNumber", "JobNumber"))
    if value not in (None, ""):
        return str(value).strip()
    jid = job_id_of(job)
    return f"Job {jid}" if jid else "Job"


def category_name_matches(staff_name: str, category_name: str) -> bool:
    staff_tokens = [tok for tok in re.sub(r"[^a-z0-9]+", " ", staff_name.lower()).split() if tok]
    cat_tokens = [tok for tok in re.sub(r"[^a-z0-9]+", " ", category_name.lower()).split() if tok]
    if not staff_tokens or not cat_tokens:
        return False
    return all(token in cat_tokens for token in staff_tokens)


def paged_items(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if isinstance(payload, dict):
        for key in ("items", "value", "results", "data"):
            if key in payload:
                return nested_rows(payload[key])
        return nested_rows(payload)
    return []


class JobWatchClient:
    def __init__(self) -> None:
        self.base_url = required_env("BIGCHANGE_BASE_URL").rstrip("/")
        username = required_env("BIGCHANGE_USERNAME")
        password = required_env("BIGCHANGE_PASSWORD")
        api_key = required_env("BIGCHANGE_API_KEY")
        token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
        self.headers = {
            "Authorization": f"Basic {token}",
            "key": api_key,
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

    def get(self, action: str, params: dict[str, Any] | None = None, timeout: int = 90, attempts: int = 3) -> dict[str, Any]:
        query = {"action": action}
        if params:
            query.update({k: v for k, v in params.items() if v is not None and v != ""})
        url = f"{self.base_url}?{urllib.parse.urlencode(query)}"
        req = urllib.request.Request(url, headers=self.headers)
        last_error: Exception | None = None
        for attempt in range(attempts):
            try:
                with urllib.request.urlopen(req, timeout=timeout) as response:
                    raw = response.read()
                payload = json.loads(raw.decode("utf-8-sig"))
                if not isinstance(payload, dict):
                    raise RuntimeError(f"Unexpected response for {action}")
                return payload
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
                last_error = exc
                if attempt == attempts - 1:
                    break
                time.sleep(2**attempt)
        raise RuntimeError(f"BigChange request failed for {action}: {type(last_error).__name__}")

    def invoices_window(self, start: dt.date, end: dt.date) -> list[dict[str, Any]]:
        payload = self.get(
            "InvoicesWithItemsByPeriod",
            {"Start": start.isoformat(), "End": end.isoformat()},
            timeout=180,
        )
        if not code_is_success(payload):
            raise RuntimeError(f"BigChange InvoicesWithItemsByPeriod failed with code {payload.get('Code')}")
        return extract_documents(payload)

    def categories(self) -> list[dict[str, Any]]:
        payload = self.get("JobCategories", timeout=60)
        if not code_is_success(payload):
            raise RuntimeError(f"BigChange JobCategories failed with code {payload.get('Code')}")
        result = payload.get("Result")
        rows = nested_rows(result)
        return rows or nested_rows(payload)


class RestClient:
    def __init__(self) -> None:
        self.customer_id = os.environ.get("BIGCHANGE_CUSTOMER_ID") or CUSTOMER_ID
        self.client_id = (
            os.environ.get("BIGCHANGE_REST_CLIENT_ID")
            or os.environ.get("BIGCHANGE_CLIENT_ID")
            or required_env("BIGCHANGE_REST_CLIENT_ID")
        )
        self.client_secret = (
            os.environ.get("BIGCHANGE_REST_CLIENT_SECRET")
            or os.environ.get("BIGCHANGE_CLIENT_SECRET")
            or required_env("BIGCHANGE_REST_CLIENT_SECRET")
        )
        self._token: str | None = None

    def token(self) -> str:
        if self._token:
            return self._token
        body = urllib.parse.urlencode(
            {
                "grant_type": "client_credentials",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
            }
        ).encode()
        req = urllib.request.Request(
            f"{REST_BASE}/auth/tokens",
            data=body,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Customer-Id": self.customer_id,
                "Accept": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8-sig"))
        token = payload.get("access_token")
        if not token:
            raise RuntimeError("BigChange REST token response had no access_token")
        self._token = str(token)
        return self._token

    def get_json(self, path: str, params: list[tuple[str, str]] | None = None, timeout: int = 90, attempts: int = 4) -> Any:
        url = f"{REST_BASE}{path}"
        if params:
            url = f"{url}?{urllib.parse.urlencode(params)}"
        last_error: Exception | None = None
        for attempt in range(attempts):
            req = urllib.request.Request(
                url,
                headers={
                    "Authorization": f"Bearer {self.token()}",
                    "Customer-Id": self.customer_id,
                    "Accept": "application/json",
                },
            )
            try:
                with urllib.request.urlopen(req, timeout=timeout) as response:
                    raw = response.read()
                if not raw:
                    return {}
                return json.loads(raw.decode("utf-8-sig"))
            except urllib.error.HTTPError as exc:
                last_error = exc
                if exc.code == 401:
                    self._token = None
                retryable = exc.code in {401, 429} or 500 <= exc.code < 600
                if not retryable or attempt == attempts - 1:
                    raise RuntimeError(f"BigChange REST GET {path} HTTP {exc.code}") from None
                time.sleep(2**attempt)
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
                last_error = exc
                if attempt == attempts - 1:
                    break
                time.sleep(2**attempt)
        raise RuntimeError(f"BigChange REST GET {path} failed: {type(last_error).__name__}")

    def jobs_window(self, start: dt.date, end: dt.date) -> list[dict[str, Any]]:
        created_from = dt.datetime.combine(start, dt.time.min, tzinfo=LONDON)
        created_to = dt.datetime.combine(end, dt.time.max.replace(microsecond=0), tzinfo=LONDON)
        jobs: list[dict[str, Any]] = []
        page = 1
        while True:
            payload = self.get_json(
                "/v1/jobs",
                [
                    ("createdAtFrom", iso_london(created_from)),
                    ("createdAtTo", iso_london(created_to)),
                    ("pageNumber", str(page)),
                    ("pageSize", "1000"),
                ],
                timeout=120,
            )
            batch = paged_items(payload)
            jobs.extend(batch)
            page_item_count = as_int(payload.get("pageItemCount")) if isinstance(payload, dict) else None
            if len(batch) < 1000 or (page_item_count is not None and page_item_count < 1000):
                return jobs
            page += 1
            if page > 200:
                raise RuntimeError("BigChange jobs pagination exceeded safety limit")

    def job_groups(self, group_ids: list[str]) -> dict[str, dict[str, Any]]:
        found: dict[str, dict[str, Any]] = {}
        unique = [gid for gid in dict.fromkeys(group_ids) if gid]
        for chunk in chunks(unique, 50):
            payload = self.get_json("/v1/jobGroups", [("id", gid) for gid in chunk], timeout=90)
            for item in paged_items(payload):
                gid = first_present(item, ("id", "Id", "ID", "jobGroupId", "JobGroupId"))
                if gid not in (None, ""):
                    found[str(gid).strip()] = item
        return found

    def job_categories(self) -> list[dict[str, Any]]:
        try:
            payload = self.get_json("/v1/jobCategories", [("pageNumber", "1"), ("pageSize", "1000")])
        except RuntimeError:
            return []
        return paged_items(payload)


def usable_documents(documents: list[dict[str, Any]], start: dt.date, end: dt.date) -> list[dict[str, Any]]:
    usable: list[dict[str, Any]] = []
    for document in documents:
        kind = classify_doc(document)
        if kind in (None, "quote"):
            continue
        if is_excluded_status(document):
            continue
        dated = document_date(document)
        if dated is not None and (dated < start or dated > end):
            continue
        usable.append({"doc": document, "kind": kind, "date": dated, "job_id": document_job_id(document)})
    return usable


def group_reference(group: dict[str, Any] | None, fallback: str) -> str:
    if not group:
        return fallback
    value = first_present(
        group,
        ("reference", "Reference", "jobGroupReference", "JobGroupReference", "ref", "Ref"),
    )
    return str(value).strip() if value not in (None, "") else fallback


def owner_job(jobs: list[dict[str, Any]]) -> dict[str, Any]:
    return sorted(jobs, key=lambda job: (job_created_at(job), as_int(job_id_of(job)) or 0, job_id_of(job)))[0]


def group_is_complete(jobs: list[dict[str, Any]]) -> bool:
    live = [job for job in jobs if not job_is_cancelled(job)]
    if not live:
        return False
    return all(job_is_completed(job) for job in live)


def empty_bucket(key: str, label: str) -> dict[str, Any]:
    return {
        "key": key,
        "label": label,
        "sale": DECIMAL_ZERO,
        "po": DECIMAL_ZERO,
        "last_invoice": None,
        "has_invoice": False,
    }


def apply_document(bucket: dict[str, Any], item: dict[str, Any]) -> None:
    amount = document_amount(item["doc"], item["kind"])
    if item["kind"] == "invoice":
        bucket["sale"] += amount
        bucket["has_invoice"] = True
        if item["date"] is not None:
            previous = bucket["last_invoice"]
            if previous is None or item["date"] > previous:
                bucket["last_invoice"] = item["date"]
    elif item["kind"] == "credit":
        bucket["sale"] -= abs(amount)
    elif item["kind"] == "po":
        bucket["po"] += amount


def exact_margin(sale: decimal.Decimal, profit: decimal.Decimal) -> decimal.Decimal | None:
    if sale == 0:
        return None
    return profit / sale * decimal.Decimal("100")


def is_anomaly(sale: decimal.Decimal, po: decimal.Decimal) -> bool:
    return sale > ANOMALY_SALE and po < ANOMALY_PO


def build_owned_buckets(
    jobs: list[dict[str, Any]],
    groups: dict[str, dict[str, Any]],
    documents: list[dict[str, Any]],
    category_id: str,
    month_start: dt.date,
    month_end: dt.date,
    history_start: dt.date,
    today: dt.date,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    groups_by_id = {str(key).strip(): value for key, value in groups.items()}
    by_group: dict[str, list[dict[str, Any]]] = {}
    standalones: dict[str, dict[str, Any]] = {}
    for job in jobs:
        jid = job_id_of(job)
        if not jid:
            continue
        gid = job_group_id(job)
        if gid:
            by_group.setdefault(gid, []).append(job)
        else:
            standalones[jid] = job

    owned: dict[str, dict[str, Any]] = {}
    for gid, group_jobs in by_group.items():
        first = owner_job(group_jobs)
        if job_category_id(first) != str(category_id):
            continue
        if not group_is_complete(group_jobs):
            continue
        label = group_reference(groups_by_id.get(gid), job_group_ref_hint(first) or f"GR/{gid}")
        owned[f"group:{gid}"] = {
            **empty_bucket(f"group:{gid}", label),
            "jobs": group_jobs,
        }
    for jid, job in standalones.items():
        if job_category_id(job) != str(category_id):
            continue
        if job_is_cancelled(job) or not job_is_completed(job):
            continue
        owned[f"job:{jid}"] = {
            **empty_bucket(f"job:{jid}", job_display_label(job)),
            "jobs": [job],
        }

    job_to_bucket = {}
    for key, bucket in owned.items():
        for job in bucket["jobs"]:
            job_to_bucket[job_id_of(job)] = key

    for item in usable_documents(documents, history_start, today):
        key = job_to_bucket.get(item["job_id"])
        if not key:
            gid = document_group_id(item["doc"])
            if gid and f"group:{gid}" in owned:
                key = f"group:{gid}"
        if not key:
            continue
        apply_document(owned[key], item)

    rows: list[dict[str, Any]] = []
    anomalies: list[dict[str, Any]] = []
    for bucket in owned.values():
        if not bucket["has_invoice"] or bucket["last_invoice"] is None:
            continue
        last_invoice = bucket["last_invoice"]
        if last_invoice < month_start or last_invoice > month_end:
            continue
        sale = bucket["sale"]
        po = bucket["po"]
        profit = sale - po
        row = {
            "date": last_invoice,
            "label": bucket["label"],
            "sale": sale,
            "po": po,
            "profit": profit,
            "margin": exact_margin(sale, profit),
        }
        if is_anomaly(sale, po):
            anomalies.append(row)
        else:
            rows.append(row)
    rows.sort(key=lambda row: (row["date"], row["label"]))
    anomalies.sort(key=lambda row: (row["date"], row["label"]))
    return rows, anomalies


def lookup_category_id(staff_name: str, rest: RestClient, jobwatch: JobWatchClient) -> str:
    sources: list[dict[str, Any]] = []
    try:
        sources.extend(rest.job_categories())
    except Exception:
        pass
    try:
        sources.extend(jobwatch.categories())
    except Exception:
        pass
    matches: list[str] = []
    for row in sources:
        name = first_present(row, ("name", "Name", "label", "Label", "JobCategoryName", "CategoryName"))
        cid = first_present(row, ("id", "Id", "ID", "categoryId", "CategoryId", "JobCategoryId"))
        if name in (None, "") or cid in (None, ""):
            continue
        if category_name_matches(staff_name, str(name)):
            matches.append(str(cid).strip())
    unique = list(dict.fromkeys(matches))
    if len(unique) == 1:
        return unique[0]
    if not unique:
        raise RuntimeError(f"Could not resolve BigChange job category id for {staff_name}")
    raise RuntimeError(f"Multiple BigChange job category ids for {staff_name}: {', '.join(unique)}")


def load_staff_rows(
    staff_name: str,
    category_id: str,
    today: dt.date,
    rest: RestClient,
    jobwatch: JobWatchClient,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    month_start, month_end = london_month_bounds(today)
    jobs = rest.jobs_window(FINANCIAL_WINDOW_START, today)
    group_ids = [job_group_id(job) for job in jobs if job_group_id(job)]
    groups = rest.job_groups(group_ids) if group_ids else {}
    documents = jobwatch.invoices_window(FINANCIAL_WINDOW_START, today)
    return build_owned_buckets(
        jobs,
        groups,
        documents,
        category_id,
        month_start,
        month_end,
        FINANCIAL_WINDOW_START,
        today,
    )
