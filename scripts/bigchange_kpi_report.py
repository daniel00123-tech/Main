#!/usr/bin/env python3
"""Generate and email the daily BigChange KPI dashboard."""

from __future__ import annotations

import base64
import concurrent.futures
import datetime as dt
import decimal
import difflib
import html
import json
import os
import re
import shutil
import smtplib
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from email import encoders
from email.headerregistry import Address
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from typing import Any


JOB_KPI_ORDER = [
    ("unallocated_jobs", "Unallocated Jobs"),
    ("historic_jobs", "Historic Jobs"),
    ("uninvoiced_jobs", "Uninvoiced Jobs"),
    ("unactioned_jobs", "Unactioned Jobs"),
]
KPI_ORDER = JOB_KPI_ORDER

SALES_ORDER_TYPES = {"invoice", "salesinvoice", "si"}
EXCLUDED_CATEGORY_NAMES = {"btr compliance", "btr reactive", "john bennett", "ryan barrett"}
EXCLUDED_STATUS_IDS = {10, 12, 13, 14}
COMPLETED_STATUS_IDS = {12, 13}
UNALLOCATED_STATUS_IDS = {1, 3}
OPEN_NOT_STARTED_STATUS_IDS = {1, 2, 3, 4, 5, 6, 7, 8, 9, 11}
LOCAL_NAME_ALIASES = {
    "amy b": "amy bradley",
    "dan dwyer": "daniel dwyer",
}
STATUS_ID_FIELDS = ("StatusId", "StatusID", "JobStatusId", "JobStatusID")
PLANNED_START_FIELDS = ("PlannedStart", "PlannedStartDate", "PlannedDate", "StartDate", "Start")
CREATED_DATE_FIELDS = ("Created", "CreatedDate", "DateCreated", "LoggedDate", "DateLogged")
STATUS_DATE_FIELDS = ("StatusDate", "JobStatusDate", "CompletedDate", "CompletionDate", "DateCompleted")
ACTIONED_FIELDS = ("Actioned", "IsActioned", "JobActioned", "HasBeenActioned")
ACTIVITY_DATE_FIELDS = ("JobClientStatusDate", "ClientStatusDate", "ActivityDate", "Created", "DateCreated")
INVOICE_OWNER_FIELDS = ("JobClientStatusOwner", "ClientStatusOwner", "Owner", "CreatedBy", "UserName", "Name")
DECIMAL_ZERO = decimal.Decimal("0")


class ConfigError(RuntimeError):
    pass


def required_env(name: str) -> str:
    value = os.environ.get(name)
    if value is None or value == "":
        raise ConfigError(f"Missing required environment variable: {name}")
    return value


def optional_env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def parse_date(value: Any) -> dt.datetime | None:
    if value in (None, "", "0001-01-01 00:00:00"):
        return None
    text = str(value).strip()
    if not text:
        return None

    formats = [
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d",
        "%d/%m/%Y %H:%M:%S",
        "%d/%m/%Y %H:%M",
        "%d/%m/%Y",
    ]
    for fmt in formats:
        try:
            return dt.datetime.strptime(text[: len(dt.datetime.now().strftime(fmt))], fmt)
        except ValueError:
            continue
    try:
        return dt.datetime.fromisoformat(text.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return None


def as_int(value: Any, default: int | None = None) -> int | None:
    if value in (None, ""):
        return default
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


def as_bool_falsey(value: Any) -> bool:
    if value in (None, ""):
        return True
    text = str(value).strip().lower()
    return text in {"0", "false", "no", "n", "none", "null"}


def code_is_success(payload: dict[str, Any]) -> bool:
    code = payload.get("Code")
    return code in (None, "", 0, "0")


def as_decimal(value: Any) -> decimal.Decimal:
    if value in (None, ""):
        return DECIMAL_ZERO
    try:
        return decimal.Decimal(str(value).replace(",", ""))
    except decimal.InvalidOperation:
        return DECIMAL_ZERO


def clean_name(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def normalized_text(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def compact_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def name_key(value: str) -> str:
    tokens = normalized_text(value).split()
    if len(tokens) >= 2 and len(tokens[0]) == 1:
        tokens = tokens[1:]
    if len(tokens) >= 2:
        return f"{tokens[0]} {tokens[-1]}"
    return " ".join(tokens)


def configured_name_aliases() -> dict[str, str]:
    aliases = dict(LOCAL_NAME_ALIASES)
    configured = optional_env("STAFF_NAME_ALIASES").strip()
    if not configured:
        return aliases
    for entry in re.split(r"[,;\n]+", configured):
        if "=" not in entry:
            continue
        alias, canonical = entry.split("=", 1)
        alias_key = name_key(alias)
        canonical_key = name_key(canonical)
        if alias_key and canonical_key:
            aliases[alias_key] = canonical_key
    return aliases


def match_staff_name(creator_name: str, staff_by_key: dict[str, str]) -> str | None:
    key = name_key(creator_name)
    if not key:
        return None
    alias_key = name_key(configured_name_aliases().get(key, ""))
    if alias_key in staff_by_key:
        return staff_by_key[alias_key]
    if key in staff_by_key:
        return staff_by_key[key]
    compacted_staff = {compact_key(staff_key): staff_name for staff_key, staff_name in staff_by_key.items()}
    compacted_key = compact_key(key)
    if compacted_key in compacted_staff:
        return compacted_staff[compacted_key]
    creator_tokens = key.split()
    for staff_key, staff_name in staff_by_key.items():
        staff_tokens = staff_key.split()
        if len(creator_tokens) >= 2 and len(staff_tokens) >= 2 and creator_tokens[0] == staff_tokens[0]:
            creator_last = creator_tokens[-1]
            staff_last = staff_tokens[-1]
            if creator_last == staff_last or creator_last.startswith(staff_last) or staff_last.startswith(creator_last):
                return staff_name
        if len(creator_tokens) == 1 and creator_tokens[0] in staff_tokens:
            return staff_name
        if len(staff_tokens) == 1 and staff_tokens[0] in creator_tokens:
            return staff_name
    match = difflib.get_close_matches(key, staff_by_key.keys(), n=1, cutoff=0.88)
    if match:
        return staff_by_key[match[0]]
    first_name_matches = [
        staff_name
        for staff_key, staff_name in staff_by_key.items()
        if len(staff_key.split()) == 1 and creator_tokens and staff_key == creator_tokens[0]
    ]
    if len(first_name_matches) == 1:
        return first_name_matches[0]
    return None


def should_exclude_category(name: str) -> bool:
    norm = normalized_text(name)
    if not norm:
        return True
    if is_excluded_named_category(norm):
        return True
    if norm in {"uncategorised", "uncategorized"}:
        return True
    if "nirvana ppm" in norm:
        return True
    if "subcontractor" in norm or "sub contractor" in norm:
        return True
    tokens = set(norm.split())
    if "ooh" in tokens or "out of hours" in norm:
        return True
    return False


def is_excluded_named_category(normalized_name: str) -> bool:
    return any(
        normalized_name == excluded or normalized_name.endswith(f" {excluded}")
        for excluded in EXCLUDED_CATEGORY_NAMES
    )


def validate_report(report: dict[str, Any]) -> None:
    excluded_rows = [
        clean_name(row.get("staff_name"))
        for row in report.get("staff_rows", [])
        if is_excluded_named_category(normalized_text(clean_name(row.get("staff_name"))))
    ]
    if excluded_rows:
        raise RuntimeError(f"Report contains excluded non-staff categories: {', '.join(excluded_rows)}")


def is_blank(value: Any) -> bool:
    return clean_name(value) == ""


def first_present(row: dict[str, Any], names: tuple[str, ...]) -> Any:
    compacted = {compact_key(key): value for key, value in row.items()}
    for name in names:
        key = compact_key(name)
        if key in compacted and compacted[key] not in (None, ""):
            return compacted[key]
    return None


def row_status_id(row: dict[str, Any]) -> int | None:
    return as_int(first_present(row, STATUS_ID_FIELDS))


def row_date(row: dict[str, Any], names: tuple[str, ...]) -> dt.datetime | None:
    return parse_date(first_present(row, names))


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
        if compact_key(key) in line_keys:
            rows = nested_rows(value)
            if rows:
                return rows
    for value in document.values():
        if isinstance(value, dict):
            rows = extract_lines(value)
            if rows:
                return rows
    if first_present(document, ("NetPrice", "VatAmount")) not in (None, ""):
        return [document]
    return []


def is_populated(value: Any) -> bool:
    text = clean_name(value)
    if not text:
        return False
    return text.lower() not in {
        "none",
        "null",
        "0",
        "false",
        "no",
        "n",
        "0001-01-01",
        "0001-01-01 00:00:00",
    }


def document_is_cancelled_deleted_or_rejected(document: dict[str, Any]) -> bool:
    return any(
        is_populated(first_present(document, names))
        for names in (
            ("CancellationDate", "CancelledDate", "Cancelled", "IsCancelled"),
            ("DeletionDate", "DeletedDate", "Deleted", "IsDeleted"),
            ("RejectionDate", "RejectedDate", "Rejected", "IsRejected"),
        )
    )


def job_category_name(row: dict[str, Any]) -> str:
    return clean_name(
        first_present(
            row,
            (
                "Category",
                "CategoryName",
                "JobCategory",
                "JobCategoryName",
                "JobCategoryLabel",
            ),
        )
    )


def document_job_id(document: dict[str, Any]) -> str:
    return clean_name(first_present(document, ("JobId", "JobID", "LinkedJobId", "LinkedJobID")))


def client_status_id(row: dict[str, Any]) -> int | None:
    return as_int(first_present(row, ("ClientStatusId", "ClientStatusID", "JobClientStatusId", "JobClientStatusID")))


class BigChangeClient:
    def __init__(self) -> None:
        auth_mode = optional_env("BIGCHANGE_AUTH_MODE", "api_key").strip().lower()
        if auth_mode and auth_mode != "api_key":
            raise ConfigError("BIGCHANGE_AUTH_MODE must be api_key")
        self.base_url = required_env("BIGCHANGE_BASE_URL")
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

    def get(
        self,
        action: str,
        params: dict[str, Any] | None = None,
        timeout: int = 60,
        attempts: int = 3,
    ) -> dict[str, Any]:
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

    @staticmethod
    def result_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
        result = payload.get("Result")
        rows = nested_rows(result)
        if rows:
            return rows
        return nested_rows(payload)

    def categories(self) -> list[dict[str, Any]]:
        payload = self.get("JobCategories")
        if not code_is_success(payload):
            raise RuntimeError("BigChange jobcategories returned an error")
        return self.result_rows(payload)

    def jobslist(self, params: dict[str, Any], page_size: int = 500) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        page = 0
        while True:
            payload = self.get(
                "JobsList",
                {
                    **params,
                    "Page": page,
                    "PageSize": page_size,
                },
            )
            if not code_is_success(payload):
                raise RuntimeError(f"BigChange jobslist returned code {payload.get('Code')}")
            batch = self.result_rows(payload)
            rows.extend(batch)
            if len(batch) < page_size:
                return rows
            page += 1
            if page > 200:
                raise RuntimeError("BigChange jobslist pagination exceeded safety limit")

    def invoices_with_items_by_period(self, start: dt.date, end: dt.date) -> list[dict[str, Any]]:
        payload = self.get(
            "InvoicesWithItemsByPeriod",
            {"Start": start.isoformat(), "End": end.isoformat()},
        )
        if not code_is_success(payload):
            raise RuntimeError("BigChange invoiceswithitemsbyperiod returned an error")
        return self.result_rows(payload)

    def web_user_list(self) -> list[dict[str, Any]]:
        payload = self.get("WebUserList")
        if not code_is_success(payload):
            raise RuntimeError("BigChange webuserlist returned an error")
        return self.result_rows(payload)

    def job_customer_activity(self, job_id: str) -> list[dict[str, Any]]:
        payload = self.get("JobCustomerActivity", {"JobId": job_id}, timeout=30, attempts=2)
        if not code_is_success(payload):
            return []
        return self.result_rows(payload)


def item_age_days(item_date: dt.datetime | None, today: dt.date) -> int:
    if item_date is None:
        return 0
    return max((today - item_date.date()).days, 0)


def months_ago(value: dt.date, months: int) -> dt.date:
    month_index = value.month - 1 - months
    year = value.year + month_index // 12
    month = month_index % 12 + 1
    day = min(value.day, days_in_month(year, month))
    return dt.date(year, month, day)


def days_in_month(year: int, month: int) -> int:
    if month == 12:
        next_month = dt.date(year + 1, 1, 1)
    else:
        next_month = dt.date(year, month + 1, 1)
    return (next_month - dt.timedelta(days=1)).day


def severity_for(count: int, oldest_age_days: int) -> str:
    if count == 0:
        return "green"
    if oldest_age_days < 10:
        return "green"
    if oldest_age_days <= 30:
        return "amber"
    return "red"


def staff_rank_key(row: dict[str, Any]) -> tuple[int, int, int, str]:
    return (row["red_kpis"], row["amber_kpis"], row["total_open_workload"], row["staff_name"])


def add_items(
    grouped: dict[str, dict[str, list[dt.datetime | None]]],
    staff_names: set[str],
    rows: list[dict[str, Any]],
    metric: str,
    date_fields: tuple[str, ...],
    today: dt.date,
) -> None:
    for row in rows:
        category = job_category_name(row)
        if should_exclude_category(category):
            continue
        staff_names.add(category)
        grouped[category][metric].append(row_date(row, date_fields))


def resource_assigned(row: dict[str, Any]) -> bool:
    resource = first_present(
        row,
        (
            "Resource",
            "Resources",
            "ResourceId",
            "ResourceID",
            "ResourceName",
            "Engineer",
            "EngineerId",
            "EngineerID",
            "EngineerName",
            "AssignedResource",
            "AssignedResourceId",
            "AssignedResourceID",
        ),
    )
    if isinstance(resource, list):
        return len(resource) > 0
    text = clean_name(resource).lower()
    return text not in {"", "none", "null", "0", "false", "no", "unassigned", "unallocated"}


def calculate_sales(
    client: BigChangeClient,
    staff_names: set[str],
    start: dt.date,
    end: dt.date,
) -> dict[str, decimal.Decimal]:
    staff_by_key = {name_key(name): name for name in staff_names if name_key(name)}
    financial_documents = client.invoices_with_items_by_period(start, end)

    eligible: list[dict[str, Any]] = []
    for document in financial_documents:
        order_type = re.sub(
            r"[^a-z]",
            "",
            clean_name(
                first_present(document, ("OrderType", "DocumentType", "DocType", "InvoiceType", "Type", "FinancialDocType"))
            ).lower(),
        )
        if order_type not in SALES_ORDER_TYPES:
            continue
        if document_is_cancelled_deleted_or_rejected(document):
            continue
        eligible.append(document)

    job_ids = sorted({document_job_id(document) for document in eligible if document_job_id(document)})
    activity_cache: dict[str, list[dict[str, Any]]] = {}
    if job_ids:
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            futures = {pool.submit(client.job_customer_activity, job_id): job_id for job_id in job_ids}
            for future in concurrent.futures.as_completed(futures):
                job_id = futures[future]
                try:
                    activity_cache[job_id] = future.result()
                except Exception:
                    activity_cache[job_id] = []

    sales: dict[str, decimal.Decimal] = defaultdict(lambda: DECIMAL_ZERO)
    for document in eligible:
        creator = invoice_created_owner(document, activity_cache)
        matched_staff = match_staff_name(creator, staff_by_key)
        if not matched_staff:
            continue
        net = DECIMAL_ZERO
        for line in extract_lines(document):
            net += as_decimal(first_present(line, ("NetPrice", "Net", "LineNet", "TotalNet"))) - as_decimal(
                first_present(line, ("VatAmount", "VATAmount", "TaxAmount"))
            )
        sales[matched_staff] += net
    return dict(sales)


def invoice_created_owner(document: dict[str, Any], activity_cache: dict[str, list[dict[str, Any]]]) -> str:
    job_id = document_job_id(document)
    if not job_id:
        return ""
    candidates: list[tuple[dt.datetime, dict[str, Any]]] = []
    for activity in activity_cache.get(job_id, []):
        if not is_invoice_created_activity(activity):
            continue
        activity_date = row_date(activity, ACTIVITY_DATE_FIELDS) or dt.datetime.min
        candidates.append((activity_date, activity))
    if not candidates:
        return ""
    candidates.sort(key=lambda item: item[0], reverse=True)
    return clean_name(first_present(candidates[0][1], INVOICE_OWNER_FIELDS))


def is_invoice_created_activity(activity: dict[str, Any]) -> bool:
    if client_status_id(activity) == 34:
        return True
    label = clean_name(
        first_present(
            activity,
            (
                "JobClientStatus",
                "JobClientStatusName",
                "ClientStatus",
                "ClientStatusName",
                "Status",
                "StatusName",
                "Action",
                "Description",
            ),
        )
    )
    compacted = compact_key(label)
    return "invoicecreated" in compacted or ("invoice" in normalized_text(label).split() and "created" in normalized_text(label).split())


def resolve_document_creator(invoice: dict[str, Any], web_users: dict[str, str]) -> str:
    creator = clean_name(
        invoice.get("OrderCreator")
        or invoice.get("DocumentCreator")
        or invoice.get("CreatedBy")
        or invoice.get("Creator")
    )
    if creator in web_users:
        return web_users[creator]
    return creator


def build_report(client: BigChangeClient) -> dict[str, Any]:
    now = dt.datetime.now(dt.timezone.utc)
    today = dt.date.today()
    tomorrow = today + dt.timedelta(days=1)
    month_start = today.replace(day=1)
    month_end = today
    lookback_start = months_ago(today, 12)

    staff_names: set[str] = set()
    for category in client.categories():
        name = clean_name(first_present(category, ("label", "JobCategoryName", "CategoryName", "Name")))
        if not should_exclude_category(name):
            staff_names.add(name)

    grouped: dict[str, dict[str, list[dt.datetime | None]]] = defaultdict(lambda: defaultdict(list))

    unallocated_rows = client.jobslist(
        {
            "Start": lookback_start.isoformat(),
            "End": tomorrow.isoformat(),
            "DateOptionId": 2,
            "Unallocated": 1,
            "StatusId": "1|3",
        }
    )
    unallocated_rows = [
        row
        for row in unallocated_rows
        if row_status_id(row) in UNALLOCATED_STATUS_IDS
        and not resource_assigned(row)
        and row_date(row, PLANNED_START_FIELDS) is None
    ]
    add_items(grouped, staff_names, unallocated_rows, "unallocated_jobs", CREATED_DATE_FIELDS, today)

    historic_end = today - dt.timedelta(days=1)
    historic_rows: list[dict[str, Any]] = []
    if lookback_start <= historic_end:
        historic_rows = client.jobslist(
            {
                "Start": lookback_start.isoformat(),
                "End": historic_end.isoformat(),
                "DateOptionId": 0,
                "Allocated": 1,
                "ExcludeNullPlannedDates": 1,
                "StatusId": "|".join(str(status) for status in sorted(OPEN_NOT_STARTED_STATUS_IDS)),
            }
        )
    historic_rows = [
        row
        for row in historic_rows
        if row_status_id(row) not in EXCLUDED_STATUS_IDS
        and resource_assigned(row)
        and (row_date(row, PLANNED_START_FIELDS) or dt.datetime.max).date() < today
    ]
    add_items(grouped, staff_names, historic_rows, "historic_jobs", PLANNED_START_FIELDS, today)

    completed_statuses = "|".join(str(status) for status in sorted(COMPLETED_STATUS_IDS))
    uninvoiced_rows = client.jobslist(
        {
            "Start": lookback_start.isoformat(),
            "End": tomorrow.isoformat(),
            "DateOptionId": 4,
            "StatusId": completed_statuses,
            "ClientStatusId": -34,
        }
    )
    uninvoiced_rows = [
        row
        for row in uninvoiced_rows
        if row_status_id(row) in COMPLETED_STATUS_IDS and client_status_id(row) == -34
    ]
    add_items(grouped, staff_names, uninvoiced_rows, "uninvoiced_jobs", STATUS_DATE_FIELDS, today)

    unactioned_rows = client.jobslist(
        {
            "Start": lookback_start.isoformat(),
            "End": tomorrow.isoformat(),
            "DateOptionId": 4,
            "StatusId": completed_statuses,
            "Unactioned": 1,
        }
    )
    unactioned_rows = [
        row
        for row in unactioned_rows
        if row_status_id(row) in COMPLETED_STATUS_IDS and as_bool_falsey(first_present(row, ACTIONED_FIELDS))
    ]
    add_items(grouped, staff_names, unactioned_rows, "unactioned_jobs", STATUS_DATE_FIELDS, today)

    sales = calculate_sales(client, staff_names, month_start, month_end)

    staff_rows: list[dict[str, Any]] = []
    for staff in sorted(staff_names):
        metrics: dict[str, dict[str, Any]] = {}
        for metric_key, _label in JOB_KPI_ORDER:
            dates = grouped[staff].get(metric_key, [])
            count = len(dates)
            oldest_date = min((date for date in dates if date is not None), default=None)
            age_days = item_age_days(oldest_date, today) if oldest_date else 0
            metrics[metric_key] = {
                "count": count,
                "oldest_age_days": age_days,
                "status": severity_for(count, age_days),
            }
        red_count = sum(1 for metric in metrics.values() if metric["status"] == "red")
        amber_count = sum(1 for metric in metrics.values() if metric["status"] == "amber")
        total_open_workload = sum(metric["count"] for metric in metrics.values())
        staff_rows.append(
            {
                "staff_name": staff,
                "metrics": metrics,
                "current_month_sales": float(sales.get(staff, DECIMAL_ZERO)),
                "current_month_sales_display": format_currency(sales.get(staff, DECIMAL_ZERO)),
                "red_kpis": red_count,
                "amber_kpis": amber_count,
                "total_open_workload": total_open_workload,
            }
        )

    staff_rows.sort(key=staff_rank_key)
    return {
        "run_timestamp": now.isoformat(),
        "report_date": today.isoformat(),
        "job_lookback_start": lookback_start.isoformat(),
        "month_name": today.strftime("%B"),
        "staff_rows": staff_rows,
        "total_red_kpis": sum(row["red_kpis"] for row in staff_rows),
        "total_amber_kpis": sum(row["amber_kpis"] for row in staff_rows),
    }


def format_currency(value: decimal.Decimal) -> str:
    rounded = value.quantize(decimal.Decimal("0.01"), rounding=decimal.ROUND_HALF_UP)
    return f"GBP {rounded:,.2f}"


def render_metric(metric: dict[str, Any]) -> str:
    status = html.escape(metric["status"])
    count = int(metric["count"])
    age = int(metric["oldest_age_days"])
    return (
        f'<div class="metric {status}">'
        f'<div class="circle"><span>{count}</span></div>'
        f'<div class="age">{age} days old</div>'
        f"</div>"
    )


def render_sales(value: str) -> str:
    return (
        '<div class="sales-value">'
        f'<strong>{html.escape(value)}</strong>'
        '<span>net sales</span>'
        "</div>"
    )


def initials(name: str) -> str:
    parts = normalized_text(name).split()
    if not parts:
        return "?"
    if len(parts) == 1:
        return parts[0][:2].upper()
    return f"{parts[0][0]}{parts[-1][0]}".upper()


def avatar_class(name: str) -> str:
    return f"avatar-{sum(ord(ch) for ch in name) % 8}"


def render_html(report: dict[str, Any]) -> str:
    rows_html = []
    for idx, row in enumerate(report["staff_rows"], start=1):
        staff = html.escape(row["staff_name"])
        cells = [
            f'<td class="rank">#{idx}</td>',
            '<td class="staff">'
            f'<div class="avatar {avatar_class(row["staff_name"])}">{html.escape(initials(row["staff_name"]))}</div>'
            f'<div class="person"><strong>{staff}</strong><span>Staff owner</span></div>'
            "</td>",
        ]
        for metric_key, _label in JOB_KPI_ORDER:
            cells.append(f"<td>{render_metric(row['metrics'][metric_key])}</td>")
        cells.append(f"<td>{render_sales(row['current_month_sales_display'])}</td>")
        rows_html.append(f"<tr>{''.join(cells)}</tr>")

    generated = html.escape(report["run_timestamp"])
    report_date = html.escape(report["report_date"])
    job_lookback_start = html.escape(report["job_lookback_start"])
    month_name = html.escape(report["month_name"])
    total_workload = sum(row["total_open_workload"] for row in report["staff_rows"])
    totals = {
        metric_key: sum(row["metrics"][metric_key]["count"] for row in report["staff_rows"])
        for metric_key, _label in KPI_ORDER
    }
    return f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>BigChange KPI Overview</title>
  <style>
    :root {{
      --bg: #07111f;
      --panel: #101c2e;
      --panel-2: #14243a;
      --text: #f3f7fb;
      --muted: #94a3b8;
      --green: #26d07c;
      --amber: #f4b63f;
      --red: #ef4d5d;
      --line: rgba(148, 163, 184, 0.22);
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      background:
        radial-gradient(circle at 10% 0%, rgba(38, 208, 124, 0.12), transparent 26rem),
        radial-gradient(circle at 90% 5%, rgba(239, 77, 93, 0.12), transparent 28rem),
        var(--bg);
      color: var(--text);
      font-family: Arial, Helvetica, sans-serif;
      padding: 34px;
    }}
    .dashboard {{
      width: 1680px;
      margin: 0 auto;
      background: linear-gradient(180deg, rgba(11, 22, 38, 0.98), rgba(8, 18, 32, 0.98));
      border: 1px solid var(--line);
      border-radius: 24px;
      overflow: hidden;
      box-shadow: 0 26px 70px rgba(0, 0, 0, 0.42);
    }}
    header {{
      padding: 24px 28px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--line);
      background:
        linear-gradient(90deg, rgba(20, 94, 177, 0.18), rgba(38, 208, 124, 0.08), rgba(239, 77, 93, 0.10)),
        rgba(10, 21, 38, 0.84);
    }}
    .brand {{
      display: flex;
      align-items: center;
      gap: 14px;
    }}
    .brand-mark {{
      width: 28px;
      height: 28px;
      border-radius: 8px;
      background: linear-gradient(135deg, #1495ff, #26d07c);
      box-shadow: 0 0 24px rgba(20, 149, 255, 0.35);
    }}
    h1 {{
      margin: 0;
      font-size: 24px;
      letter-spacing: -0.03em;
      line-height: 1.1;
      text-transform: uppercase;
    }}
    .sub {{
      margin-top: 8px;
      color: var(--muted);
      font-size: 13px;
    }}
    .summary {{
      display: flex;
      gap: 12px;
    }}
    .badge {{
      min-width: 122px;
      padding: 12px 14px;
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.055);
      border: 1px solid var(--line);
      text-align: center;
    }}
    .badge strong {{
      display: block;
      font-size: 28px;
      line-height: 1;
    }}
    .badge span {{
      display: block;
      margin-top: 5px;
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.11em;
    }}
    .badge.red strong {{ color: var(--red); }}
    .badge.amber strong {{ color: var(--amber); }}
    .total-cards {{
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 14px;
      padding: 18px 24px;
      border-bottom: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.018);
    }}
    .total-card {{
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 14px 16px;
      background: linear-gradient(180deg, rgba(20, 36, 58, 0.74), rgba(13, 26, 45, 0.74));
    }}
    .total-card span {{
      display: block;
      color: var(--muted);
      font-size: 12px;
      letter-spacing: 0.10em;
      text-transform: uppercase;
    }}
    .total-card strong {{
      display: block;
      margin-top: 8px;
      font-size: 30px;
      letter-spacing: -0.04em;
    }}
    table {{
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }}
    .table-wrap {{
      overflow-x: auto;
    }}
    th {{
      color: #cbd5e1;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      font-weight: 700;
      padding: 16px 10px;
      border-bottom: 1px solid var(--line);
      background: rgba(20, 36, 58, 0.74);
    }}
    th:nth-child(1), td:nth-child(1) {{ width: 72px; }}
    th:nth-child(2), td:nth-child(2) {{ width: 292px; }}
    th:nth-child(7), td:nth-child(7) {{ width: 192px; }}
    td {{
      padding: 14px 10px;
      border-bottom: 1px solid var(--line);
      text-align: center;
      vertical-align: middle;
    }}
    tr:nth-child(even) td {{ background: rgba(255, 255, 255, 0.025); }}
    tr:last-child td {{ border-bottom: none; }}
    .rank {{
      color: #e2e8f0;
      font-weight: 900;
      font-size: 18px;
    }}
    .staff {{
      text-align: left;
      padding-left: 12px;
    }}
    .staff, .person {{
      display: flex;
      align-items: center;
      gap: 12px;
    }}
    .person {{
      align-items: flex-start;
      flex-direction: column;
      gap: 2px;
    }}
    .person strong {{
      font-size: 18px;
      letter-spacing: -0.02em;
    }}
    .person span {{
      color: var(--muted);
      font-size: 12px;
    }}
    .avatar {{
      width: 36px;
      height: 36px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-size: 12px;
      font-weight: 900;
      box-shadow: 0 0 18px rgba(255, 255, 255, 0.12);
    }}
    .avatar-0 {{ background: #7c3aed; }}
    .avatar-1 {{ background: #2563eb; }}
    .avatar-2 {{ background: #16a34a; }}
    .avatar-3 {{ background: #f97316; }}
    .avatar-4 {{ background: #db2777; }}
    .avatar-5 {{ background: #0891b2; }}
    .avatar-6 {{ background: #84cc16; }}
    .avatar-7 {{ background: #ef4444; }}
    .sales-value {{
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
    }}
    .sales-value strong {{
      color: #f8fafc;
      font-size: 20px;
      letter-spacing: -0.04em;
    }}
    .sales-value span {{
      color: var(--muted);
      font-size: 12px;
    }}
    .metric {{
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
    }}
    .circle {{
      width: 66px;
      height: 66px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(255, 255, 255, 0.045);
      box-shadow: inset 0 0 22px rgba(255, 255, 255, 0.05), 0 0 18px rgba(0, 0, 0, 0.18);
    }}
    .circle span {{
      font-size: 24px;
      line-height: 1;
      font-weight: 900;
      letter-spacing: -0.05em;
    }}
    .green .circle {{
      border: 3px dotted var(--green);
      color: var(--green);
    }}
    .amber .circle {{
      border: 3px solid var(--amber);
      color: var(--amber);
    }}
    .red .circle {{
      border: 3px solid var(--red);
      color: var(--red);
    }}
    .age {{
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }}
    footer {{
      padding: 16px 28px 22px;
      color: var(--muted);
      font-size: 12px;
      border-top: 1px solid var(--line);
    }}
    @media (max-width: 900px) {{
      body {{ padding: 12px; }}
      .dashboard {{ width: 100%; border-radius: 18px; }}
      header {{ align-items: flex-start; flex-direction: column; gap: 18px; }}
      .summary {{ flex-wrap: wrap; }}
      .total-cards {{ grid-template-columns: 1fr; }}
      table {{ min-width: 1180px; }}
    }}
  </style>
</head>
<body>
  <main class="dashboard">
    <header>
      <div class="brand">
        <div class="brand-mark"></div>
        <div>
          <h1>Aquilo BigChange KPI Overview</h1>
          <div class="sub">Generated {report_date} - jobs from {job_lookback_start} onwards, grouped by job category staff owner</div>
        </div>
      </div>
      <div class="summary">
        <div class="badge red"><strong>{int(report["total_red_kpis"])}</strong><span>Red KPIs</span></div>
        <div class="badge amber"><strong>{int(report["total_amber_kpis"])}</strong><span>Amber KPIs</span></div>
        <div class="badge"><strong>{total_workload}</strong><span>Open items</span></div>
      </div>
    </header>
    <section class="total-cards">
      <div class="total-card"><span>Unallocated jobs</span><strong>{totals["unallocated_jobs"]}</strong></div>
      <div class="total-card"><span>Historic jobs</span><strong>{totals["historic_jobs"]}</strong></div>
      <div class="total-card"><span>Uninvoiced jobs</span><strong>{totals["uninvoiced_jobs"]}</strong></div>
      <div class="total-card"><span>Unactioned jobs</span><strong>{totals["unactioned_jobs"]}</strong></div>
    </section>
    <section class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Rank</th>
          <th>Staff member</th>
          <th>Unallocated Jobs</th>
          <th>Historic Jobs</th>
          <th>Uninvoiced Jobs</th>
          <th>Unactioned Jobs</th>
          <th>{month_name} sales</th>
        </tr>
      </thead>
      <tbody>
        {''.join(rows_html)}
      </tbody>
    </table>
    </section>
    <footer>Generated {generated}. Green dotted circles are clear or under 10 days old; amber is 10-30 days; red is over 30 days.</footer>
  </main>
</body>
</html>
"""


def save_baseline(report: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    baseline_rows = []
    for row in report["staff_rows"]:
        baseline_rows.append(
            {
                "staff_name": row["staff_name"],
                "counts": {metric_key: row["metrics"][metric_key]["count"] for metric_key, _ in KPI_ORDER},
                "statuses": {metric_key: row["metrics"][metric_key]["status"] for metric_key, _ in KPI_ORDER},
                "oldest_age_days": {
                    metric_key: row["metrics"][metric_key]["oldest_age_days"] for metric_key, _ in KPI_ORDER
                },
                "current_month_sales": row["current_month_sales"],
            }
        )
    baseline = {
        "run_timestamp": report["run_timestamp"],
        "report_date": report["report_date"],
        "job_lookback_start": report["job_lookback_start"],
        "staff": baseline_rows,
    }
    path.write_text(json.dumps(baseline, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def render_png(html_content: str, html_path: Path, png_path: Path, row_count: int) -> None:
    html_path.parent.mkdir(parents=True, exist_ok=True)
    png_path.parent.mkdir(parents=True, exist_ok=True)
    html_path.write_text(html_content, encoding="utf-8")
    height = max(780, min(5000, 260 + row_count * 130))
    chrome = optional_env("CHROME_BIN")
    if not chrome:
        chrome = next(
            (
                candidate
                for candidate in (
                    "/opt/google/chrome/chrome",
                    shutil.which("google-chrome"),
                    shutil.which("google-chrome-stable"),
                    shutil.which("chromium"),
                    shutil.which("chromium-browser"),
                )
                if candidate and Path(candidate).exists()
            ),
            "google-chrome",
        )
    with tempfile.TemporaryDirectory(prefix="bigchange-chrome-") as profile_dir:
        cmd = [
            chrome,
            "--headless=new",
            "--no-sandbox",
            "--disable-gpu",
            "--hide-scrollbars",
            f"--user-data-dir={profile_dir}",
            f"--window-size=1740,{height}",
            f"--screenshot={png_path}",
            html_path.resolve().as_uri(),
        ]
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)


def mailbox_address(email_value: str, display_name: str = "") -> Address:
    username, domain = email_value.split("@", 1)
    return Address(display_name=display_name, username=username, domain=domain)


def send_email(png_path: Path) -> None:
    smtp_host = required_env("SMTP_HOST")
    smtp_port = int(required_env("SMTP_PORT"))
    smtp_username = required_env("SMTP_USERNAME")
    smtp_password = required_env("SMTP_PASSWORD")
    from_email = required_env("SMTP_FROM_EMAIL").strip()
    from_name = optional_env("SMTP_FROM_NAME")
    to_email = required_env("SMTP_TO_EMAIL").strip()
    cc_email = optional_env("SMTP_CC_EMAIL").strip()

    subject = "Daily KPI Overview Report"
    root = MIMEMultipart("related")
    root["Subject"] = subject
    root["From"] = str(mailbox_address(from_email, from_name))
    root["To"] = to_email
    recipients = [to_email]
    if cc_email:
        root["Cc"] = cc_email
        recipients.extend([addr.strip() for addr in cc_email.split(",") if addr.strip()])

    alt = MIMEMultipart("alternative")
    root.attach(alt)

    text_body = """Dear Team,

Please see attached KPIs for today to work on. Reds and yellows need to be cleared down as soon as possible. Please let me know if you need any support.

Thank you.

Kind regards,
Daniel Dwyer
"""
    html_body = """<p>Dear Team,</p>
<p>Please see attached KPIs for today to work on. Reds and yellows need to be cleared down as soon as possible. Please let me know if you need any support.</p>
<p><img src="cid:kpi-dashboard" alt="BigChange KPI dashboard" style="max-width: 100%; height: auto;"></p>
<p>Thank you.</p>
<p>Kind regards,<br>Daniel Dwyer</p>"""
    alt.attach(MIMEText(text_body, "plain", "utf-8"))
    alt.attach(MIMEText(html_body, "html", "utf-8"))

    image_data = png_path.read_bytes()
    attachment = MIMEBase("image", "png")
    attachment.set_payload(image_data)
    encoders.encode_base64(attachment)
    attachment.add_header("Content-ID", "<kpi-dashboard>")
    attachment.add_header("Content-Disposition", "attachment", filename=png_path.name)
    root.attach(attachment)

    # The only attachment is the dashboard PNG; JSON and HTML stay on disk only.
    with smtplib.SMTP(smtp_host, smtp_port, timeout=120) as smtp:
        smtp.starttls()
        smtp.login(smtp_username, smtp_password)
        smtp.sendmail(from_email, recipients, root.as_string())


def main() -> int:
    try:
        client = BigChangeClient()
        report = build_report(client)
        validate_report(report)
        html_content = render_html(report)
        reports_dir = Path("reports")
        html_path = reports_dir / "bigchange-kpi-dashboard.html"
        png_path = reports_dir / "bigchange-kpi-dashboard.png"
        baseline_path = Path("automation-memory") / "kpi-baseline.json"
        render_png(html_content, html_path, png_path, len(report["staff_rows"]))
        save_baseline(report, baseline_path)
        email_status = "sent"
        exit_code = 0
        try:
            send_email(png_path)
        except Exception:
            email_status = "failed"
            exit_code = 1
        print(
            json.dumps(
                {
                    "staff_rows_included": len(report["staff_rows"]),
                    "total_red_kpis": report["total_red_kpis"],
                    "total_amber_kpis": report["total_amber_kpis"],
                    "email": email_status,
                },
                sort_keys=True,
            )
        )
        return exit_code
    except Exception:
        print(
            json.dumps(
                {
                    "staff_rows_included": 0,
                    "total_red_kpis": 0,
                    "total_amber_kpis": 0,
                    "email": "failed",
                },
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
