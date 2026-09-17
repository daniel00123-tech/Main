"""Payroll Labour from planned hours (not timesheets) at £37.50/h."""

from __future__ import annotations

import datetime as dt
import decimal
import re
from collections import defaultdict
from typing import Any

from .settings import (
    ESSENTIALZ_PO_NEEDLES,
    EXEMPT_RESOURCE_GROUPS,
    IQBAL_NAME_NEEDLE,
    KNOWN_SUBCONTRACTOR_NEEDLES,
    LABOUR_RATE,
)
from .util import as_decimal, clean_name, compact_key, first_present, money, parse_datetime, parse_hours

D = decimal.Decimal
ZERO = D("0")
NOON = dt.time(12, 0)
EVENING = dt.time(17, 0)


def resource_name(job: dict[str, Any]) -> str:
    value = first_present(
        job,
        (
            "Resource",
            "ResourceName",
            "AssignedResource",
            "Engineer",
            "EngineerName",
        ),
    )
    if isinstance(value, list):
        names = [clean_name(item if not isinstance(item, dict) else first_present(item, ("Name", "Resource"))) for item in value]
        return clean_name(" / ".join(n for n in names if n))
    if isinstance(value, dict):
        return clean_name(first_present(value, ("Name", "Resource", "ResourceName")))
    return clean_name(value)


def resource_group_label(job: dict[str, Any], group_map: dict[str, str] | None = None) -> str:
    direct = first_present(
        job,
        (
            "ResourceGroup",
            "ResourceGroupName",
            "ResourceType",
            "ResourceCategory",
        ),
    )
    if isinstance(direct, dict):
        label = clean_name(first_present(direct, ("Name", "ResourceGroup", "Type")))
    else:
        label = clean_name(direct)
    if label:
        return label
    name = resource_name(job)
    if group_map and name:
        mapped = group_map.get(name.lower()) or group_map.get(compact_key(name))
        if mapped:
            return mapped
    return ""


def is_unassigned(job: dict[str, Any]) -> bool:
    name = resource_name(job)
    if not name:
        return True
    return name.lower() in {"unassigned", "unallocated", "none", "n/a", "-"}


def is_known_subcontractor_name(name: str) -> bool:
    key = name.lower()
    return any(needle in key for needle in KNOWN_SUBCONTRACTOR_NEEDLES)


def _group_is_exempt(group: str) -> bool:
    text = group.lower().strip()
    compact = compact_key(group)
    if not text:
        return False
    if "subcontract" in text:
        return True
    if "exemployee" in compact or "ex employee" in text or "ex-employee" in text:
        return True
    if re.search(r"(^|[^a-z])office([^a-z]|$)", text):
        return True
    if compact in {compact_key(g) for g in EXEMPT_RESOURCE_GROUPS}:
        return True
    return False


def attracts_labour(job: dict[str, Any], group_map: dict[str, str] | None = None) -> bool:
    if is_unassigned(job):
        return False
    name = resource_name(job)
    if is_known_subcontractor_name(name):
        return False
    group = resource_group_label(job, group_map)
    if _group_is_exempt(group):
        return False
    return True


def is_iqbal_resource(name: str) -> bool:
    return IQBAL_NAME_NEEDLE in name.lower()


def po_matches_essentialz_or_iqbal(po: dict[str, Any]) -> bool:
    text = " ".join(
        clean_name(
            first_present(
                po,
                (
                    "Supplier",
                    "SupplierName",
                    "Contact",
                    "ContactName",
                    "AccountName",
                    "Description",
                    "Narrative",
                    "Reference",
                    "OrderDescription",
                    "Title",
                ),
            )
        )
        for _ in range(1)
    )
    chunks = [
        first_present(
            po,
            (
                "Supplier",
                "SupplierName",
                "Contact",
                "ContactName",
                "AccountName",
                "Description",
                "Narrative",
                "Reference",
                "OrderDescription",
                "Title",
                "CustomerName",
            ),
        )
    ]
    lines = po.get("lines") or []
    if isinstance(lines, list):
        for line in lines:
            if isinstance(line, dict):
                chunks.append(first_present(line, ("Description", "Narrative", "Item", "Name")))
    blob = " ".join(clean_name(c) for c in chunks if c).lower()
    if not blob:
        return False
    compact = compact_key(blob)
    for needle in ESSENTIALZ_PO_NEEDLES:
        if needle in blob or compact_key(needle) in compact:
            return True
    return False


def group_has_iqbal_po_offset(docs: list[dict[str, Any]]) -> bool:
    for doc in docs:
        if str(doc.get("kind") or "") != "po":
            continue
        if po_matches_essentialz_or_iqbal(doc.get("raw") or doc):
            return True
    return False


def is_cancelled_job(job: dict[str, Any]) -> bool:
    status = clean_name(first_present(job, ("Status", "JobStatus", "State"))).lower()
    if status in {"cancelled", "canceled", "deleted"}:
        return True
    if first_present(job, ("DeletionDate", "DeletedDate", "CancelledDate", "CancellationDate")) not in (None, "", "0001-01-01 00:00:00"):
        text = str(first_present(job, ("DeletionDate", "DeletedDate", "CancelledDate", "CancellationDate")))
        if text and text not in {"0001-01-01", "0001-01-01 00:00:00"}:
            return True
    return False


def is_ppm_job(job: dict[str, Any]) -> bool:
    job_type = clean_name(
        first_present(job, ("Type", "JobType", "JobTypeName", "TypeName", "WorkType"))
    )
    return "ppm" in job_type.lower()


def planned_start(job: dict[str, Any]) -> dt.datetime | None:
    return parse_datetime(
        first_present(
            job,
            ("PlannedStart", "PlannedStartDate", "PlannedDate", "StartDate", "Start"),
        )
    )


def planned_hours(job: dict[str, Any]) -> D:
    direct = first_present(
        job,
        (
            "PlannedDurationHours",
            "DurationHours",
            "EstimatedHours",
            "PlannedHours",
        ),
    )
    if direct not in (None, ""):
        return parse_hours(direct)
    duration = first_present(
        job,
        ("PlannedDuration", "Duration", "EstimatedDuration", "TimeTaken", "AllocatedHours"),
    )
    if duration not in (None, ""):
        return parse_hours(duration)
    start = planned_start(job)
    end = parse_datetime(first_present(job, ("PlannedEnd", "PlannedEndDate", "EndDate", "End")))
    if start and end and end > start:
        seconds = D(str((end - start).total_seconds()))
        return seconds / D("3600")
    return ZERO


def work_hours(job: dict[str, Any]) -> D:
    planned = planned_hours(job)
    if is_ppm_job(job):
        return planned
    return max(planned, D("1.5"))


def _scale(values: list[D], cap: D) -> list[D]:
    total = sum(values, ZERO)
    if total <= cap or total == 0:
        return values
    factor = cap / total
    return [money(v * factor) for v in values]


def paid_hours_for_day(jobs: list[dict[str, Any]]) -> dict[Any, D]:
    """Paid hours per job id for one engineer on one calendar day."""
    if not jobs:
        return {}
    items = []
    for job in jobs:
        start = planned_start(job) or parse_datetime("1970-01-01 00:00:00")
        items.append(
            {
                "id": job.get("_job_id") if job.get("_job_id") is not None else first_present(job, ("JobId", "Id")),
                "job": job,
                "planned": planned_hours(job),
                "work": work_hours(job),
                "start": start,
                "ppm": is_ppm_job(job),
            }
        )

    planned_sum = sum((item["planned"] for item in items), ZERO)
    paid: list[D] = []

    if len(items) == 1:
        item = items[0]
        if (not item["ppm"]) and item["planned"] <= D("1"):
            paid = [D("2")]
        elif item["planned"] >= D("8"):
            paid = [D("8")]
        else:
            paid = [item["work"] + D("1")]
    else:
        travel = ZERO if planned_sum >= D("8") else D("0.5")
        paid = [item["work"] + travel for item in items]

    single_long_day = len(items) == 1 and items[0]["planned"] >= D("8")
    clock = []
    for item in items:
        moment = item["start"]
        clock.append(moment.timetz().replace(tzinfo=None) if moment else dt.time(0, 0))

    if (
        not single_long_day
        and len(items) <= 2
        and all(t < NOON for t in clock)
        and planned_sum <= D("4")
        and planned_sum < D("8")
    ):
        paid = _scale(paid, D("4"))

    day_idx = [i for i, t in enumerate(clock) if t < EVENING]
    if day_idx:
        day_paid = [paid[i] for i in day_idx]
        day_total = sum(day_paid, ZERO)
        if day_total > D("8"):
            scaled = _scale(day_paid, D("8"))
            for i, value in zip(day_idx, scaled):
                paid[i] = value

    return {items[i]["id"]: money(paid[i]) for i in range(len(items))}


def labour_pounds(paid_hours: D) -> D:
    return money(paid_hours * LABOUR_RATE)


def compute_job_labour(
    jobs: list[dict[str, Any]],
    *,
    docs_by_group: dict[Any, list[dict[str, Any]]] | None = None,
    group_map: dict[str, str] | None = None,
) -> dict[Any, D]:
    """Return labour £ keyed by JobId. Cancelled / exempt resources are £0."""
    docs_by_group = docs_by_group or {}
    eligible_by_engineer_day: dict[tuple[str, dt.date], list[dict[str, Any]]] = defaultdict(list)
    labour: dict[Any, D] = {}

    for job in jobs:
        job_id = job.get("_job_id")
        if job_id is None:
            job_id = first_present(job, ("JobId", "Id"))
        labour[job_id] = ZERO
        if is_cancelled_job(job):
            continue
        if not attracts_labour(job, group_map):
            continue
        start = planned_start(job)
        if start is None:
            # Unplanned but assigned engineer: still count work hours as a lone job.
            day = None
        else:
            day = start.date()
        engineer = resource_name(job).lower()
        key = (engineer, day or dt.date(1970, 1, 1))
        tagged = dict(job)
        tagged["_job_id"] = job_id
        eligible_by_engineer_day[key].append(tagged)

    for day_jobs in eligible_by_engineer_day.values():
        hours = paid_hours_for_day(day_jobs)
        for job_id, paid in hours.items():
            labour[job_id] = labour_pounds(paid)

    # Iqbal + Essentialz/Iqbal PO on the group: keep the PO, zero Iqbal payroll.
    jobs_by_id = {}
    for job in jobs:
        job_id = job.get("_job_id")
        if job_id is None:
            job_id = first_present(job, ("JobId", "Id"))
        jobs_by_id[job_id] = job

    for job_id, job in jobs_by_id.items():
        if not is_iqbal_resource(resource_name(job)):
            continue
        gid = job.get("_group_id")
        if gid is None:
            gid = first_present(job, ("JobGroupId", "GroupId"))
        if group_has_iqbal_po_offset(docs_by_group.get(gid, [])):
            labour[job_id] = ZERO

    return labour
