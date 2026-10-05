"""Contract and recurring-work detection for Nirvana job groups.

Explicit BigChange contract data wins. Heuristics cover long-running groups
and monthly same-value invoices only when no explicit marker is present.
"""

from __future__ import annotations

import calendar
import datetime as dt
from dataclasses import dataclass
from typing import Any

from .util import as_decimal, as_int, clean_name, first_present, gbp, is_populated, money, parse_date

D = __import__("decimal").Decimal
ZERO = D("0")

CONTRACT_ID_FIELDS = (
    "JobContractId",
    "ContractId",
    "ContractID",
    "ContractSectionId",
)
CONTRACT_TEXT_FIELDS = (
    "ContractName",
    "ContractReference",
    "ContractSection",
)
PREFERRED_ACTIVITY_FIELDS = (
    "PlannedStart",
    "PlannedStartDate",
    "PlannedDate",
    "RealStart",
    "ActualStart",
    "ActualStartDate",
    "RealEnd",
    "ActualEnd",
    "CompletedDate",
    "CompletionDate",
    "StatusDate",
    "PlannedEnd",
    "PlannedEndDate",
)
CREATED_FIELDS = (
    "Created",
    "CreatedDate",
    "DateCreated",
    "LoggedDate",
)


class ContractEvaluationError(RuntimeError):
    """Raised when contract status cannot be judged without guessing."""


def positive_contract_id(value: Any) -> int | None:
    if value in (None, "", 0, "0", False, "false"):
        return None
    parsed = as_int(value)
    if parsed is None or parsed <= 0:
        return None
    return parsed


def _explicit_from_mapping(row: dict[str, Any]) -> bool:
    for key in CONTRACT_ID_FIELDS:
        if positive_contract_id(first_present(row, (key,))) is not None:
            return True
    nested = row.get("Contract")
    if isinstance(nested, dict):
        if positive_contract_id(first_present(nested, ("ContractId", "Id", "ID", "JobContractId"))) is not None:
            return True
        if any(is_populated(first_present(nested, (key,))) for key in CONTRACT_TEXT_FIELDS + ("Name", "Reference")):
            return True
    for key in CONTRACT_TEXT_FIELDS:
        if is_populated(first_present(row, (key,))):
            return True
    return False


def job_has_explicit_contract(job: dict[str, Any]) -> bool:
    return _explicit_from_mapping(job)


def document_has_explicit_contract(doc: dict[str, Any]) -> bool:
    if positive_contract_id(doc.get("contract_id")) is not None:
        return True
    if is_populated(doc.get("contract_reference")):
        return True
    raw = doc.get("raw")
    if isinstance(raw, dict) and _explicit_from_mapping(raw):
        return True
    return False


def _sensible(day: dt.date | None) -> dt.date | None:
    if day is None or day.year < 2000:
        return None
    return day


def job_activity_dates(job: dict[str, Any]) -> list[dt.date]:
    found: list[dt.date] = []
    for key in PREFERRED_ACTIVITY_FIELDS:
        day = _sensible(parse_date(first_present(job, (key,))))
        if day:
            found.append(day)
    if found:
        return found
    for key in CREATED_FIELDS:
        day = _sensible(parse_date(first_present(job, (key,))))
        if day:
            found.append(day)
    return found


def add_months(day: dt.date, months: int) -> dt.date:
    month_index = day.month - 1 + months
    year = day.year + month_index // 12
    month = month_index % 12 + 1
    last = calendar.monthrange(year, month)[1]
    return dt.date(year, month, min(day.day, last))


def spans_more_than_months(start: dt.date, end: dt.date, months: int = 3) -> bool:
    return end > add_months(start, months)


def month_distance(start: dt.date, end: dt.date) -> int:
    return max(0, (end.year - start.year) * 12 + (end.month - start.month))


def group_activity_span(members: list[dict[str, Any]]) -> tuple[dt.date | None, dt.date | None, bool]:
    """Return earliest, latest, and whether every job contributed a date."""
    dates: list[dt.date] = []
    complete = True
    for job in members:
        job_dates = job_activity_dates(job)
        if not job_dates:
            complete = False
            continue
        dates.extend(job_dates)
    if not dates:
        return None, None, False
    return min(dates), max(dates), complete


def customer_site(members: list[dict[str, Any]]) -> str:
    if not members:
        return ""
    job = min(
        members,
        key=lambda item: (
            parse_date(first_present(item, CREATED_FIELDS)) or dt.date(1970, 1, 1),
            as_int(first_present(item, ("JobId", "Id"))) or 0,
        ),
    )
    contact = clean_name(first_present(job, ("Contact", "ContactName", "Customer", "CustomerName")))
    site = clean_name(first_present(job, ("Location", "Site", "SiteName")))
    if contact and site and site.lower() not in contact.lower():
        return f"{contact} / {site}"
    return contact or site


@dataclass(frozen=True)
class ContractDecision:
    excluded: bool
    reason: str
    job_count: int
    span_start: dt.date | None
    span_end: dt.date | None


def _span_reason(count: int, start: dt.date, end: dt.date) -> str:
    months = month_distance(start, end)
    return f"{count} jobs spanning {months} months"


def _recurring_reason(count: int, net: D, months: int) -> str:
    return f"{count} recurring invoices of {gbp(net)} across {months} months"


def recurring_invoice_reason(docs: list[dict[str, Any]]) -> str:
    """Five or more same-net invoices across two or more calendar months.

    Same-value invoices inside one month are a short billing event, not a
    contract. Credits are ignored. Invoice nets are compared at document level.
    """
    grouped: dict[D, list[dict[str, Any]]] = {}
    seen: set[str] = set()
    undated_same_value: dict[D, int] = {}
    for doc in docs:
        if doc.get("kind") != "invoice":
            continue
        identity = str(doc.get("document_id") or "")
        if identity:
            if identity in seen:
                continue
            seen.add(identity)
        net = money(as_decimal(doc.get("net_ex_vat")))
        when = doc.get("document_date")
        if not isinstance(when, dt.date):
            undated_same_value[net] = undated_same_value.get(net, 0) + 1
            continue
        grouped.setdefault(net, []).append(doc)

    for net, count in undated_same_value.items():
        dated = len(grouped.get(net, []))
        if count + dated >= 5 and dated < 5:
            raise ContractEvaluationError(
                "Invoice dates are missing on possible recurring contract invoices; "
                "refusing to guess contract status"
            )

    for net, invoices in grouped.items():
        if len(invoices) < 5:
            continue
        months = {(item["document_date"].year, item["document_date"].month) for item in invoices}
        if len(months) < 2:
            continue
        return _recurring_reason(len(invoices), net, len(months))
    return ""


def classify_contract_group(members: list[dict[str, Any]], docs: list[dict[str, Any]]) -> ContractDecision:
    count = len(members)
    start, end, dates_complete = group_activity_span(members)
    if count >= 10 and start is None:
        raise ContractEvaluationError(
            f"Job group has {count} jobs but no activity dates; "
            "refusing to guess whether it is contract work"
        )
    if count >= 10 and not dates_complete and start and end and not spans_more_than_months(start, end, 3):
        raise ContractEvaluationError(
            f"Job group has {count} jobs and incomplete activity dates; "
            "refusing to guess whether it spans more than 3 months"
        )

    if any(job_has_explicit_contract(job) for job in members) or any(
        document_has_explicit_contract(doc) for doc in docs
    ):
        return ContractDecision(True, "Explicit BigChange contract", count, start, end)

    if count >= 10 and start and end and spans_more_than_months(start, end, 3):
        return ContractDecision(True, _span_reason(count, start, end), count, start, end)

    recurring = recurring_invoice_reason(docs)
    if recurring:
        return ContractDecision(True, recurring, count, start, end)

    return ContractDecision(False, "", count, start, end)


def format_span(start: dt.date | None, end: dt.date | None) -> str:
    if start is None or end is None:
        return ""
    if start == end:
        return start.strftime("%d/%m/%Y")
    return f"{start.strftime('%d/%m/%Y')} – {end.strftime('%d/%m/%Y')}"
