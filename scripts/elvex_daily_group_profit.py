#!/usr/bin/env python3
"""Read-only daily GR/ group job profit report.

Email body is the results table plus a short totals block.
Do not put a method essay, job-id notes, or secrets in the email.
"""

from __future__ import annotations

import base64
import concurrent.futures
import datetime as dt
import decimal
import html
import json
import os
import re
import sys
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
FROM_EMAIL = "ella@elvexpropertyservices.com"
TO_EMAIL = "ella@elvexpropertyservices.com"
CC_EMAIL = "william@elvexpropertyservices.com"
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


def money(value: decimal.Decimal) -> str:
    quantized = value.quantize(decimal.Decimal("0.01"))
    return f"£{quantized:,.2f}"


def margin_pct(sale: decimal.Decimal, profit: decimal.Decimal) -> decimal.Decimal | None:
    if sale == 0:
        return None
    return (profit / sale * decimal.Decimal("100")).quantize(decimal.Decimal("0.1"))


def margin_colour(margin: decimal.Decimal | None) -> str | None:
    if margin is None:
        return None
    if margin < decimal.Decimal("20"):
        return "#f4c7c3"
    if margin < decimal.Decimal("35"):
        return "#ffe599"
    if margin > decimal.Decimal("45"):
        return "#b6d7a8"
    return None


def fmt_date(value: dt.date) -> str:
    return value.strftime("%d/%m/%Y")


def build_html(yesterday: dt.date, rows: list[dict[str, Any]]) -> str:
    """Table plus a short totals block. No method notes above the table."""
    table_rows = []
    if not rows:
        table_rows.append(
            '<tr><td colspan="6" style="padding:8px;border:1px solid #ccc;">No GR/ groups invoiced yesterday.</td></tr>'
        )
    else:
        for row in rows:
            margin = row["margin"]
            colour = margin_colour(margin)
            margin_text = "n/a" if margin is None else f"{margin}%"
            style = f"background-color:{colour};" if colour else ""
            table_rows.append(
                "<tr>"
                f'<td style="padding:8px;border:1px solid #ccc;">{html.escape(fmt_date(yesterday))}</td>'
                f'<td style="padding:8px;border:1px solid #ccc;">{html.escape(row["ref"])}</td>'
                f'<td style="padding:8px;border:1px solid #ccc;text-align:right;">{html.escape(money(row["sale"]))}</td>'
                f'<td style="padding:8px;border:1px solid #ccc;text-align:right;">{html.escape(money(row["po"]))}</td>'
                f'<td style="padding:8px;border:1px solid #ccc;text-align:right;">{html.escape(money(row["profit"]))}</td>'
                f'<td style="padding:8px;border:1px solid #ccc;text-align:right;{style}">{html.escape(margin_text)}</td>'
                "</tr>"
            )

    sale = sum((r["sale"] for r in rows), DECIMAL_ZERO)
    po = sum((r["po"] for r in rows), DECIMAL_ZERO)
    profit = sale - po
    overall_margin = margin_pct(sale, profit)
    colours = [margin_colour(r["margin"]) for r in rows]
    red = sum(1 for c in colours if c == "#f4c7c3")
    yellow = sum(1 for c in colours if c == "#ffe599")
    green = sum(1 for c in colours if c == "#b6d7a8")
    na = sum(1 for r in rows if r["margin"] is None)
    overall_margin_text = "n/a" if overall_margin is None else f"{overall_margin}%"

    return f"""<!DOCTYPE html>
<html>
<body style="font-family:Calibri,Arial,sans-serif;font-size:12pt;color:#222;">
<table style="border-collapse:collapse;min-width:720px;">
<thead>
<tr style="background-color:#f2f2f2;">
<th style="padding:8px;border:1px solid #ccc;text-align:left;">Date</th>
<th style="padding:8px;border:1px solid #ccc;text-align:left;">Group reference number</th>
<th style="padding:8px;border:1px solid #ccc;text-align:right;">Total sale value</th>
<th style="padding:8px;border:1px solid #ccc;text-align:right;">Total purchase order value</th>
<th style="padding:8px;border:1px solid #ccc;text-align:right;">Profit</th>
<th style="padding:8px;border:1px solid #ccc;text-align:right;">Profit margin %</th>
</tr>
</thead>
<tbody>
{''.join(table_rows)}
</tbody>
</table>
<p>
<strong>Summary</strong><br>
Groups: {len(rows)}<br>
Overall sale: {html.escape(money(sale))}<br>
Overall purchase orders: {html.escape(money(po))}<br>
Overall profit: {html.escape(money(profit))}<br>
Overall margin: {html.escape(overall_margin_text)}<br>
Colours — red: {red}, yellow: {yellow}, green: {green}, n/a: {na}
</p>
</body>
</html>
"""


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

    def probe_auth(self, today: dt.date) -> None:
        payload = self.get(
            "InvoicesWithItemsByPeriod",
            {"Start": today.isoformat(), "End": today.isoformat()},
            timeout=60,
        )
        if not code_is_success(payload):
            raise RuntimeError(f"BigChange auth/probe failed with code {payload.get('Code')}")

    def invoices_window(self, start: dt.date, end: dt.date) -> list[dict[str, Any]]:
        payload = self.get(
            "InvoicesWithItemsByPeriod",
            {"Start": start.isoformat(), "End": end.isoformat()},
            timeout=120,
        )
        if not code_is_success(payload):
            raise RuntimeError(f"BigChange InvoicesWithItemsByPeriod failed with code {payload.get('Code')}")
        return extract_documents(payload)

    def job(self, job_id: str) -> dict[str, Any] | None:
        payload = self.get("Job", {"JobId": job_id}, timeout=30, attempts=2)
        if not code_is_success(payload):
            return None
        result = payload.get("Result")
        if isinstance(result, dict):
            return result
        rows = nested_rows(result)
        return rows[0] if rows else None


def job_group_from_job(job: dict[str, Any]) -> tuple[str | None, str | None]:
    group = job.get("JobGroup")
    if not isinstance(group, dict):
        for key in ("jobGroup", "Group", "JobGroupDetails"):
            if isinstance(job.get(key), dict):
                group = job[key]
                break
    if isinstance(group, dict):
        ref = first_present(group, ("JobGroupReference", "Reference", "Ref", "GroupReference"))
        gid = first_present(group, ("JobGroupId", "Id", "ID"))
        return (str(ref).strip() if ref else None, str(gid).strip() if gid else None)
    ref = first_present(job, ("JobGroupReference", "GroupReference", "GroupRef"))
    gid = first_present(job, ("JobGroupId", "GroupId"))
    return (str(ref).strip() if ref else None, str(gid).strip() if gid else None)


def document_job_id(document: dict[str, Any]) -> str:
    value = first_present(document, ("JobId", "JobID", "LinkedJobId", "LinkedJobID"))
    return str(value).strip() if value not in (None, "") else ""


def document_group_hint(document: dict[str, Any]) -> tuple[str | None, str | None]:
    ref = first_present(document, ("JobGroupReference", "GroupReference", "GroupRef", "JobGroupRef"))
    gid = first_present(document, ("JobGroupId", "GroupId"))
    return (str(ref).strip() if ref else None, str(gid).strip() if gid else None)


class GroupResolver:
    def __init__(self, client: JobWatchClient) -> None:
        self.client = client
        self.job_cache: dict[str, dict[str, Any] | None] = {}
        self.rest_groups: dict[str, str] = {}
        self._load_rest_groups()

    def _load_rest_groups(self) -> None:
        client_id = (
            os.environ.get("BIGCHANGE_REST_CLIENT_ID")
            or os.environ.get("BIGCHANGE_CLIENT_ID")
            or os.environ.get("BC_REST_CLIENT_ID")
        )
        client_secret = (
            os.environ.get("BIGCHANGE_REST_CLIENT_SECRET")
            or os.environ.get("BIGCHANGE_CLIENT_SECRET")
            or os.environ.get("BC_REST_CLIENT_SECRET")
        )
        if not client_id or not client_secret:
            return
        try:
            body = urllib.parse.urlencode(
                {
                    "grant_type": "client_credentials",
                    "client_id": client_id,
                    "client_secret": client_secret,
                }
            ).encode()
            req = urllib.request.Request(
                "https://api.bigchange.com/auth/tokens",
                data=body,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Customer-Id": CUSTOMER_ID,
                    "Accept": "application/json",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=30) as response:
                token_payload = json.loads(response.read().decode("utf-8-sig"))
            token = token_payload.get("access_token")
            if not token:
                return
            req = urllib.request.Request(
                "https://api.bigchange.com/v1/jobGroups",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Customer-Id": CUSTOMER_ID,
                    "Accept": "application/json",
                },
            )
            with urllib.request.urlopen(req, timeout=60) as response:
                groups = json.loads(response.read().decode("utf-8-sig"))
            items = groups if isinstance(groups, list) else groups.get("items") or groups.get("value") or []
            for item in items:
                if not isinstance(item, dict):
                    continue
                gid = first_present(item, ("id", "jobGroupId", "Id"))
                ref = first_present(item, ("reference", "jobGroupReference", "Reference"))
                if gid and ref:
                    self.rest_groups[str(gid)] = str(ref)
        except Exception:
            self.rest_groups = {}

    def prefetch_jobs(self, job_ids: list[str]) -> None:
        unique = [jid for jid in dict.fromkeys(job_ids) if jid and jid not in self.job_cache]
        if not unique:
            return

        def fetch(job_id: str) -> tuple[str, dict[str, Any] | None]:
            try:
                return job_id, self.client.job(job_id)
            except Exception:
                return job_id, None

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            for job_id, job in pool.map(fetch, unique):
                self.job_cache[job_id] = job
        missing = [jid for jid in unique if not self.job_cache.get(jid)]
        for job_id in missing:
            try:
                self.job_cache[job_id] = self.client.job(job_id)
            except Exception:
                self.job_cache[job_id] = None

    def resolve(self, document: dict[str, Any]) -> tuple[str | None, str | None]:
        ref, gid = document_group_hint(document)
        if ref and str(ref).upper().startswith("GR/"):
            return str(ref), gid
        if gid and gid in self.rest_groups:
            rest_ref = self.rest_groups[gid]
            if rest_ref.upper().startswith("GR/"):
                return rest_ref, gid
        job_id = document_job_id(document)
        if job_id:
            job = self.job_cache.get(job_id)
            if job is None and job_id not in self.job_cache:
                job = self.client.job(job_id)
                self.job_cache[job_id] = job
            if job:
                job_ref, job_gid = job_group_from_job(job)
                if job_ref and job_ref.upper().startswith("GR/"):
                    return job_ref, job_gid or gid
                if job_gid and job_gid in self.rest_groups:
                    rest_ref = self.rest_groups[job_gid]
                    if rest_ref.upper().startswith("GR/"):
                        return rest_ref, job_gid
        return None, gid


def graph_token() -> str:
    tenant = (
        os.environ.get("MS_TENANT_ID")
        or os.environ.get("MICROSOFT_TENANT_ID")
        or os.environ.get("GRAPH_TENANT_ID")
        or os.environ.get("AZURE_TENANT_ID")
    )
    client_id = (
        os.environ.get("MS_CLIENT_ID")
        or os.environ.get("MICROSOFT_CLIENT_ID")
        or os.environ.get("GRAPH_CLIENT_ID")
        or os.environ.get("AZURE_CLIENT_ID")
    )
    client_secret = (
        os.environ.get("MS_CLIENT_SECRET")
        or os.environ.get("MICROSOFT_CLIENT_SECRET")
        or os.environ.get("GRAPH_CLIENT_SECRET")
        or os.environ.get("AZURE_CLIENT_SECRET")
    )
    if not tenant or not client_id or not client_secret:
        raise ConfigError("Missing Microsoft Graph application credentials")
    body = urllib.parse.urlencode(
        {
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
            "scope": "https://graph.microsoft.com/.default",
        }
    ).encode()
    req = urllib.request.Request(
        f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    token = payload.get("access_token")
    if not token:
        raise RuntimeError("Microsoft Graph token response had no access_token")
    return token


def send_graph_mail(subject: str, html_body: str, to_email: str, cc_email: str | None = None) -> None:
    token = graph_token()
    message: dict[str, Any] = {
        "message": {
            "subject": subject,
            "body": {"contentType": "HTML", "content": html_body},
            "from": {"emailAddress": {"address": FROM_EMAIL}},
            "toRecipients": [{"emailAddress": {"address": to_email}}],
        },
        "saveToSentItems": True,
    }
    if cc_email:
        message["message"]["ccRecipients"] = [{"emailAddress": {"address": cc_email}}]
    data = json.dumps(message).encode("utf-8")
    req = urllib.request.Request(
        f"https://graph.microsoft.com/v1.0/users/{urllib.parse.quote(FROM_EMAIL)}/sendMail",
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            response.read()
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Graph sendMail HTTP {exc.code}") from None


def send_with_retry(subject: str, html_body: str, to_email: str, cc_email: str | None = None) -> None:
    try:
        send_graph_mail(subject, html_body, to_email, cc_email)
    except Exception:
        time.sleep(2)
        send_graph_mail(subject, html_body, to_email, cc_email)


def send_failure(reason: str) -> None:
    body = (
        "<p>The daily GR/ group job profit report failed before a complete table could be sent.</p>"
        f"<p>{html.escape(reason)}</p>"
        "<p>No secrets are included. BigChange was not written to.</p>"
    )
    send_with_retry(
        "Elvex daily group job profit — FAILED",
        body,
        "william@elvexpropertyservices.com",
        None,
    )


def build_report(client: JobWatchClient, yesterday: dt.date, today: dt.date) -> tuple[str, dict[str, Any]]:
    documents = client.invoices_window(FINANCIAL_WINDOW_START, today)
    usable: list[dict[str, Any]] = []
    for document in documents:
        kind = classify_doc(document)
        if kind in (None, "quote"):
            continue
        if is_excluded_status(document):
            continue
        usable.append({"doc": document, "kind": kind, "date": document_date(document)})

    resolver = GroupResolver(client)
    resolver.prefetch_jobs([document_job_id(item["doc"]) for item in usable])

    grouped: dict[str, dict[str, Any]] = {}
    for item in usable:
        ref, _gid = resolver.resolve(item["doc"])
        if not ref or not ref.upper().startswith("GR/"):
            continue
        bucket = grouped.setdefault(
            ref,
            {"ref": ref, "sale": DECIMAL_ZERO, "po": DECIMAL_ZERO, "invoiced_yesterday": False},
        )
        amount = document_amount(item["doc"], item["kind"])
        if item["kind"] in {"invoice", "credit"}:
            bucket["sale"] += amount
            if item["date"] == yesterday:
                bucket["invoiced_yesterday"] = True
        elif item["kind"] == "po":
            bucket["po"] += amount

    rows = []
    for ref in sorted(grouped, key=lambda r: (int(re.sub(r"\D", "", r) or 0), r)):
        bucket = grouped[ref]
        if not bucket["invoiced_yesterday"]:
            continue
        sale = bucket["sale"]
        po = bucket["po"]
        profit = sale - po
        rows.append(
            {
                "ref": ref,
                "sale": sale,
                "po": po,
                "profit": profit,
                "margin": margin_pct(sale, profit),
            }
        )

    html_body = build_html(yesterday, rows)
    summary = {
        "date": fmt_date(yesterday),
        "groups": [r["ref"] for r in rows],
        "count": len(rows),
        "sale": str(sum((r["sale"] for r in rows), DECIMAL_ZERO)),
        "po": str(sum((r["po"] for r in rows), DECIMAL_ZERO)),
    }
    return html_body, summary


def main() -> int:
    now = dt.datetime.now(LONDON)
    today = now.date()
    yesterday = today - dt.timedelta(days=1)
    try:
        client = JobWatchClient()
        client.probe_auth(today)
        html_body, summary = build_report(client, yesterday, today)
        subject = f"Elvex daily group job profit — {fmt_date(yesterday)}"
        send_with_retry(subject, html_body, TO_EMAIL, CC_EMAIL)
        print(f"SENT date={summary['date']} groups={summary['count']} sale={summary['sale']} po={summary['po']}")
        return 0
    except ConfigError as exc:
        try:
            send_failure(str(exc))
        except Exception:
            print("FAILURE_EMAIL_FAILED", file=sys.stderr)
        print(f"CONFIG_ERROR: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        try:
            send_failure(f"{type(exc).__name__}: {exc}")
        except Exception:
            print("FAILURE_EMAIL_FAILED", file=sys.stderr)
        print(f"ERROR: {type(exc).__name__}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
