"""Payroll labor cost from planned job duration (read-only job data).

Subcontractors (resource group name contains \"subcontractor\") are excluded;
their cost is expected on purchase orders. Employee engineers/operatives use a
fixed hourly rate on planned duration with day-level caps and travel allowances.
"""

from __future__ import annotations

import datetime as dt
import decimal
import re
from dataclasses import dataclass
from typing import Any
from zoneinfo import ZoneInfo

D = decimal.Decimal
ZERO = D("0")
TWOP = D("0.01")
LONDON = ZoneInfo("Europe/London")

HOURLY_RATE = D("37.50")
MIN_JOB_HOURS = D("1.5")
SINGLE_JOB_TRAVEL_HOURS = D("1")
MULTI_JOB_TRAVEL_HOURS = D("0.5")
FULL_DAY_CAP_HOURS = D("8")
HALF_DAY_CAP_HOURS = D("4")
AFTER_HOURS_START = dt.time(17, 0)
MORNING_CUTOFF = dt.time(12, 0)

SUBCONTRACTOR_GROUP_RE = re.compile(r"subcontract", re.I)


def money(value: D) -> D:
    return value.quantize(TWOP, rounding=decimal.ROUND_HALF_UP)


def as_dec(value: Any) -> D:
    if value in (None, ""):
        return ZERO
    if isinstance(value, D):
        return value
    return D(str(value))


def first_present(row: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        if key in row and row[key] not in (None, ""):
            return row[key]
    return None


def clean_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def is_ppm_job(job: dict[str, Any]) -> bool:
    for key in ("typeName", "jobType", "type", "Type", "Description", "description"):
        text = clean_text(job.get(key)).upper()
        if "PPM" in text:
            return True
    return False


def resource_group_name(job: dict[str, Any]) -> str:
    direct = first_present(
        job,
        (
            "resourceGroupName",
            "ResourceGroupName",
            "resourceGroup",
            "ResourceGroup",
            "resourceGroupLabel",
        ),
    )
    if direct is not None:
        return clean_text(direct)
    nested = job.get("resourceGroup") or job.get("ResourceGroup")
    if isinstance(nested, dict):
        return clean_text(
            first_present(nested, ("name", "Name", "label", "Label", "description"))
        )
    resources = job.get("resources") or job.get("Resources")
    if isinstance(resources, list) and resources:
        first = resources[0]
        if isinstance(first, dict):
            return clean_text(
                first_present(
                    first,
                    ("resourceGroupName", "groupName", "ResourceGroupName", "group"),
                )
            )
    return ""


def is_subcontractor_job(job: dict[str, Any]) -> bool:
    group = resource_group_name(job)
    if not group:
        return False
    return bool(SUBCONTRACTOR_GROUP_RE.search(group))


def is_employee_job(job: dict[str, Any]) -> bool:
    if is_subcontractor_job(job):
        return False
    resource = first_present(
        job,
        (
            "resourceId",
            "ResourceId",
            "resourceName",
            "ResourceName",
            "engineerId",
            "EngineerId",
            "engineerName",
            "EngineerName",
            "assignedResourceId",
            "AssignedResourceId",
        ),
    )
    if resource is None:
        resources = job.get("resources") or job.get("Resources")
        if isinstance(resources, list) and resources:
            return True
        return False
    if isinstance(resource, list):
        return len(resource) > 0
    text = clean_text(resource).lower()
    return text not in {"", "none", "null", "0", "unassigned", "unallocated"}


def engineer_key(job: dict[str, Any]) -> str:
    for key in (
        "resourceId",
        "ResourceId",
        "engineerId",
        "EngineerId",
        "assignedResourceId",
        "AssignedResourceId",
    ):
        val = job.get(key)
        if val not in (None, ""):
            return f"id:{val}"
    for key in ("resourceName", "ResourceName", "engineerName", "EngineerName"):
        val = clean_text(job.get(key))
        if val:
            return f"name:{val.lower()}"
    resources = job.get("resources") or job.get("Resources")
    if isinstance(resources, list) and resources:
        first = resources[0]
        if isinstance(first, dict):
            rid = first_present(first, ("id", "Id", "resourceId", "ResourceId"))
            if rid not in (None, ""):
                return f"id:{rid}"
            name = clean_text(first_present(first, ("name", "Name", "label")))
            if name:
                return f"name:{name.lower()}"
    return "unknown"


def parse_planned_start(job: dict[str, Any]) -> dt.datetime | None:
    raw = first_present(
        job,
        (
            "plannedStartAt",
            "plannedStart",
            "PlannedStart",
            "PlannedStartAt",
            "scheduledStartAt",
            "scheduledStart",
            "startAt",
            "StartAt",
        ),
    )
    if raw is None:
        return None
    text = str(raw).strip().replace("Z", "+00:00")
    try:
        parsed = dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(LONDON)


def planned_duration_hours(job: dict[str, Any]) -> D:
    minutes_raw = first_present(
        job,
        (
            "plannedDurationMinutes",
            "PlannedDurationMinutes",
            "plannedDuration",
            "PlannedDuration",
            "durationMinutes",
            "DurationMinutes",
            "plannedMinutes",
        ),
    )
    hours_raw = first_present(job, ("plannedDurationHours", "PlannedDurationHours"))
    if minutes_raw not in (None, ""):
        return as_dec(minutes_raw) / D("60")
    if hours_raw not in (None, ""):
        return as_dec(hours_raw)
    return ZERO


def planned_work_hours(job: dict[str, Any]) -> D:
    hours = planned_duration_hours(job)
    if hours <= 0:
        hours = MIN_JOB_HOURS
    if not is_ppm_job(job) and hours < MIN_JOB_HOURS:
        hours = MIN_JOB_HOURS
    return hours


def work_date(job: dict[str, Any]) -> dt.date | None:
    start = parse_planned_start(job)
    if start is not None:
        return start.date()
    for key in ("createdAt", "actualStartAt", "actualEndAt"):
        raw = job.get(key)
        if not raw:
            continue
        text = str(raw).strip().replace("Z", "+00:00")
        try:
            parsed = dt.datetime.fromisoformat(text)
        except ValueError:
            continue
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        return parsed.astimezone(LONDON).date()
    return None


@dataclass(frozen=True)
class LaborJob:
    job_id: int
    engineer: str
    work_date: dt.date
    planned_hours: D
    work_hours: D
    is_ppm: bool
    starts_after_five: bool
    start_time: dt.time | None


def labor_jobs_from_members(members: list[dict[str, Any]]) -> list[LaborJob]:
    out: list[LaborJob] = []
    for job in members:
        if not is_employee_job(job):
            continue
        when = work_date(job)
        if when is None:
            continue
        start = parse_planned_start(job)
        start_time = start.time() if start else None
        out.append(
            LaborJob(
                job_id=int(job["id"]),
                engineer=engineer_key(job),
                work_date=when,
                planned_hours=planned_duration_hours(job) or MIN_JOB_HOURS,
                work_hours=planned_work_hours(job),
                is_ppm=is_ppm_job(job),
                starts_after_five=start_time is not None and start_time >= AFTER_HOURS_START,
                start_time=start_time,
            )
        )
    return out


def is_half_day(jobs: list[LaborJob]) -> bool:
    if len(jobs) > 2:
        return False
    if not jobs:
        return False
    for item in jobs:
        if item.start_time is None:
            return False
        if item.start_time >= MORNING_CUTOFF:
            return False
    return True


def allocate_engineer_day(jobs: list[LaborJob]) -> dict[int, D]:
    """Return paid hours per job id for one engineer on one calendar day."""
    if not jobs:
        return {}

    def single_before_five_paid(job: LaborJob) -> D:
        if job.work_hours >= FULL_DAY_CAP_HOURS:
            return FULL_DAY_CAP_HOURS
        if job.planned_hours <= D("1") and not job.is_ppm:
            return D("2")
        travel = SINGLE_JOB_TRAVEL_HOURS
        return job.work_hours + travel

    jobs_sorted = sorted(jobs, key=lambda j: (j.start_time or dt.time(0, 0), j.job_id))
    half_day = is_half_day(jobs_sorted)
    day_cap = HALF_DAY_CAP_HOURS if half_day else FULL_DAY_CAP_HOURS

    before_five = [j for j in jobs_sorted if not j.starts_after_five]
    after_five = [j for j in jobs_sorted if j.starts_after_five]

    paid_before: dict[int, D] = {}
    if len(before_five) == 1:
        job = before_five[0]
        paid_before[job.job_id] = single_before_five_paid(job)
    elif before_five:
        planned_sum = sum((j.work_hours for j in before_five), ZERO)
        skip_travel = planned_sum >= FULL_DAY_CAP_HOURS
        raw: dict[int, D] = {}
        for job in before_five:
            travel = ZERO if skip_travel else MULTI_JOB_TRAVEL_HOURS
            raw[job.job_id] = job.work_hours + travel
        total = sum(raw.values(), ZERO)
        if total > day_cap:
            scale = day_cap / total if total > 0 else ZERO
            for jid, hours in raw.items():
                paid_before[jid] = hours * scale
        else:
            paid_before = raw

    paid_after: dict[int, D] = {}
    for job in after_five:
        if len(after_five) == 1 and not before_five:
            paid_after[job.job_id] = single_before_five_paid(job)
        else:
            travel = MULTI_JOB_TRAVEL_HOURS if len(after_five) > 1 else SINGLE_JOB_TRAVEL_HOURS
            paid_after[job.job_id] = job.work_hours + travel

    merged: dict[int, D] = dict(paid_before)
    for jid, hours in paid_after.items():
        merged[jid] = merged.get(jid, ZERO) + hours
    return merged


def labor_cost_for_jobs(members: list[dict[str, Any]]) -> tuple[D, dict[int, D]]:
    """Total payroll labor for group/standalone members and per job-id breakdown."""
    labor_jobs = labor_jobs_from_members(members)
    by_day: dict[tuple[str, dt.date], list[LaborJob]] = {}
    for item in labor_jobs:
        by_day.setdefault((item.engineer, item.work_date), []).append(item)

    hours_by_job: dict[int, D] = {}
    for day_jobs in by_day.values():
        allocated = allocate_engineer_day(day_jobs)
        for jid, hours in allocated.items():
            hours_by_job[jid] = hours_by_job.get(jid, ZERO) + hours

    total_hours = sum(hours_by_job.values(), ZERO)
    total_cost = money(total_hours * HOURLY_RATE)
    cost_by_job = {jid: money(hours * HOURLY_RATE) for jid, hours in hours_by_job.items()}
    return total_cost, cost_by_job


def labor_for_bucket(members: list[dict[str, Any]]) -> D:
    total, _breakdown = labor_cost_for_jobs(members)
    return total
