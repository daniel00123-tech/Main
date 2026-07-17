#!/usr/bin/env python3
"""Daily BigChange BTR allocation workflow.

Scans the TEST BigChange environment for recent unallocated BTR jobs and stale
incomplete BTR diary entries, applies eligible schedules when requested, and
writes the daily audit summary expected by the automation.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from bigchange_btr_allocation import (  # noqa: E402
    BigChangeClient,
    CLOSED_STATUS_IDS,
    Recommendation,
    adjacent_bookings,
    as_int,
    build_recommendation,
    contractor_exclusion,
    determine_role,
    diary_blocks,
    estimate_duration,
    fetch_unallocated_jobs,
    find_slot,
    identify_site,
    is_cancelled_diary_job,
    is_ppm_job,
    load_rules,
    normalise,
    overlaps,
    parse_datetime,
    parse_duration,
    ppm_tech_diary_review,
    resource_absence_blocks,
    resource_is_active_for_jobwatch,
    resource_is_excluded,
    resource_role,
    resource_site,
    resource_working_windows,
    slot_has_overlap,
)


AUDIT_PATH = ROOT / "automation-memory/btr-allocation-audit.jsonl"
SUMMARY_DIR = ROOT / "automation-memory"
LOOKBACK_DAYS = 14
SEARCH_DAYS = 14
OPEN_STATUS_LABELS = {"sent", "scheduled", "new", "accepted", "started"}
CANCELLED_STATUS_LABELS = {"completed", "cancelled", "deleted", "rejected"}
COVER_JOB_TERMS = ("agency cover",)


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def load_audited_refs() -> set[str]:
    refs: set[str] = set()
    if not AUDIT_PATH.exists():
        return refs
    for line in AUDIT_PATH.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        ref = str(record.get("job_ref") or "").strip()
        if ref:
            refs.add(ref)
    return refs


def append_audit(record: dict[str, Any]) -> None:
    AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with AUDIT_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")


def fetch_job_by_id(client: BigChangeClient, job_id: int) -> dict[str, Any] | None:
    payload = client.get("Job", {"JobId": job_id})
    if payload.get("Code") not in (0, None):
        return None
    result = payload.get("Result")
    if isinstance(result, list):
        return result[0] if result and isinstance(result[0], dict) else None
    return result if isinstance(result, dict) else None


def is_closed_or_cancelled(job: dict[str, Any]) -> bool:
    status = normalise(job.get("Status"))
    if status in CANCELLED_STATUS_LABELS:
        return True
    return as_int(job.get("StatusId")) in CLOSED_STATUS_IDS


def is_cover_job(job: dict[str, Any]) -> bool:
    ref = normalise(job.get("Ref"))
    job_type = normalise(job.get("Type"))
    description = normalise(job.get("Description"))
    return ref.startswith("cover") or any(term in job_type or term in description for term in COVER_JOB_TERMS)


def resource_label(resource: dict[str, Any]) -> str:
    return str(resource.get("label") or "")


def resources_by_name(resources: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {normalise(resource_label(resource)): resource for resource in resources}


def resource_id(resource: dict[str, Any]) -> int:
    return int(resource["id"])


def is_site_role_resource(resource: dict[str, Any], rules: dict[str, Any]) -> bool:
    name = resource_label(resource)
    return (
        resource_is_active_for_jobwatch(resource)
        and not resource_is_excluded(name, rules)
        and resource_site(name, rules) is not None
        and resource_role(name, rules) in {"Tech", "CT", "HK"}
    )


def site_for_diary_job(job: dict[str, Any], rules: dict[str, Any]) -> tuple[str | None, str]:
    resource_name = str(job.get("Resource") or "")
    resource_match = resource_site(resource_name, rules)
    if resource_match:
        return resource_match, f"Matched assigned resource '{resource_name}'"
    site_match = identify_site(job, rules)
    if site_match:
        return site_match.site, site_match.method
    return None, "Site could not be identified confidently"


def next_working_day(day: dt.date) -> dt.date:
    current = day
    while current.weekday() >= 5:
        current += dt.timedelta(days=1)
    return current


def find_resource_slot(
    client: BigChangeClient,
    rules: dict[str, Any],
    resource: dict[str, Any],
    duration_minutes: int,
    *,
    start_day: dt.date,
    search_days: int = SEARCH_DAYS,
    extra_blocks: list[tuple[dt.datetime, dt.datetime, str]] | None = None,
) -> tuple[dt.date, dt.time, dt.time, str, str] | None:
    rid = resource_id(resource)
    end_day = start_day + dt.timedelta(days=search_days)
    diary = client.resource_diary(rid, start_day, end_day)
    schedule_jobs = [job for job in diary if not is_cancelled_diary_job(job)]
    working_hours_cache: dict[int, list[dict[str, Any]]] = {}
    absence_cache: dict[int, list[dict[str, Any]]] = {}

    for offset in range(search_days + 1):
        day = start_day + dt.timedelta(days=offset)
        if day.weekday() >= 5:
            continue
        windows = resource_working_windows(client, rid, day, working_hours_cache, rules)
        blocks = diary_blocks(schedule_jobs, day) + resource_absence_blocks(client, rid, day, absence_cache)
        if extra_blocks:
            day_start = dt.datetime.combine(day, dt.time.min)
            day_end = dt.datetime.combine(day, dt.time.max)
            blocks.extend(
                (start, end, label)
                for start, end, label in extra_blocks
                if start < day_end and end > day_start
            )
        blocks.sort(key=lambda item: item[0])
        slot = find_slot(blocks, day, duration_minutes, windows)
        if not slot:
            continue
        slot_start = dt.datetime.combine(day, slot.start)
        slot_end = dt.datetime.combine(day, slot.end)
        if slot_has_overlap(blocks, slot_start, slot_end):
            continue
        before, after = adjacent_bookings(blocks, slot_start, slot_end)
        return day, slot.start, slot.end, before, after
    return None


def add_reservation(
    reservations: dict[int, list[tuple[dt.datetime, dt.datetime, str]]],
    resource_id_value: int,
    day: dt.date,
    start: dt.time,
    end: dt.time,
    label: str,
) -> None:
    reservations[resource_id_value].append(
        (dt.datetime.combine(day, start), dt.datetime.combine(day, end), label)
    )


def non_cancelled_overlap_conflicts(
    diary: list[dict[str, Any]],
    job_id: int,
    slot_start: dt.datetime,
    slot_end: dt.datetime,
) -> list[str]:
    conflicts: list[str] = []
    for entry in diary:
        if as_int(entry.get("JobId")) == job_id or is_cancelled_diary_job(entry):
            continue
        entry_start = parse_datetime(entry.get("PlannedStart"))
        entry_end = parse_datetime(entry.get("PlannedEnd"))
        if not entry_start:
            continue
        if not entry_end:
            duration = parse_duration(entry.get("Duration")) or 60
            entry_end = entry_start + dt.timedelta(minutes=duration)
        if entry_end and overlaps(slot_start, slot_end, entry_start, entry_end):
            conflicts.append(
                f"{entry.get('Ref')} {entry_start.strftime('%H:%M')}-{entry_end.strftime('%H:%M')}"
            )
    return conflicts


def verify_schedule(
    client: BigChangeClient,
    job_id: int,
    job_ref: str,
    resource_id_value: int,
    scheduled_day: dt.date,
) -> tuple[bool, str]:
    job = fetch_job_by_id(client, job_id)
    planned = parse_datetime(job.get("PlannedStart")) if job else None
    resource_name = normalise(job.get("Resource")) if job else ""
    if not planned:
        return False, "job has no PlannedStart after scheduling"
    if not resource_name:
        return False, "job has no Resource after scheduling"
    diary = client.resource_diary(resource_id_value, scheduled_day, scheduled_day)
    in_diary = any(as_int(entry.get("JobId")) == job_id for entry in diary)
    if not in_diary:
        return False, f"{job_ref} not found on intended resource diary after scheduling"
    if planned:
        duration = parse_duration(job.get("Duration")) or 60
        planned_end = parse_datetime(job.get("PlannedEnd")) or planned + dt.timedelta(minutes=duration)
        conflicts = non_cancelled_overlap_conflicts(diary, job_id, planned, planned_end)
        if conflicts:
            return False, f"{job_ref} overlaps existing diary booking(s): {', '.join(conflicts)}"
        absence_blocks = resource_absence_blocks(client, resource_id_value, scheduled_day, {})
        if slot_has_overlap(absence_blocks, planned, planned_end):
            labels = ", ".join(label for _start, _end, label in absence_blocks)
            return False, f"{job_ref} overlaps resource absence ({labels})"
    return True, "verified on job and resource diary"


def schedule_with_verification(
    client: BigChangeClient,
    rules: dict[str, Any],
    *,
    job_id: int,
    job_ref: str,
    resource: dict[str, Any],
    scheduled_day: dt.date,
    start: dt.time,
    end: dt.time,
    duration_minutes: int,
    extra_blocks: list[tuple[dt.datetime, dt.datetime, str]] | None = None,
) -> tuple[dt.date, dt.time, dt.time, str]:
    rid = resource_id(resource)
    schedule_dt = f"{scheduled_day.isoformat()} {start.strftime('%H:%M')}:00"
    client.schedule_job(job_id, rid, schedule_dt, duration_minutes)
    verified, message = verify_schedule(client, job_id, job_ref, rid, scheduled_day)
    if verified:
        return scheduled_day, start, end, message

    retry_start = next_working_day(dt.date.today())
    retry_slot = find_resource_slot(
        client,
        rules,
        resource,
        duration_minutes,
        start_day=retry_start,
        extra_blocks=extra_blocks,
    )
    if not retry_slot:
        raise RuntimeError(f"Scheduled but verification failed ({message}); no retry slot found")
    retry_day, retry_start_time, retry_end_time, _before, _after = retry_slot
    retry_dt = f"{retry_day.isoformat()} {retry_start_time.strftime('%H:%M')}:00"
    client.schedule_job(job_id, rid, retry_dt, duration_minutes)
    verified, retry_message = verify_schedule(client, job_id, job_ref, rid, retry_day)
    if not verified:
        raise RuntimeError(f"Retry schedule verification failed: {retry_message}")
    return retry_day, retry_start_time, retry_end_time, f"retry after verification failure: {message}"


def confidence_mode(confidence: str) -> str:
    return f"daily_allocate_{confidence.lower()}"


def recommendation_record(
    recommendation: Recommendation,
    *,
    job_id: int,
    mode: str,
    verification: str,
    original_date: str | None = None,
    previously_audited: bool = False,
) -> dict[str, Any]:
    record: dict[str, Any] = {
        "timestamp": utc_now().isoformat(),
        "job_ref": recommendation.job_ref,
        "job_id": job_id,
        "site": recommendation.site,
        "resource": recommendation.proposed_resource,
        "resource_id": recommendation.proposed_resource_id,
        "scheduled_date": recommendation.proposed_date,
        "start": recommendation.proposed_start,
        "end": recommendation.proposed_end,
        "duration_minutes": recommendation.duration_minutes,
        "confidence": recommendation.confidence,
        "mode": mode,
        "overlap_check": recommendation.overlap_check,
        "verification": verification,
    }
    if original_date:
        record["original_date"] = original_date
    if previously_audited:
        record["previously_audited_unallocated_again"] = True
    return record


def process_unallocated(
    client: BigChangeClient,
    rules: dict[str, Any],
    audited_refs: set[str],
    reservations: dict[int, list[tuple[dt.datetime, dt.datetime, str]]],
    *,
    apply: bool,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], int]:
    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    non_btr_count = 0

    for job in fetch_unallocated_jobs(client, lookback_days=LOOKBACK_DAYS):
        job_ref = str(job.get("Ref") or "")
        site_match = identify_site(job, rules)
        if not site_match:
            non_btr_count += 1
            continue

        if is_cover_job(job):
            skipped.append(
                {
                    "ref": job_ref,
                    "site": site_match.site,
                    "reason": "Cover/agency job requires manual rota review; not auto-allocated",
                    "manual_review": "cover",
                    "mode": "unallocated",
                }
            )
            continue

        excluded, exclusion_reason = contractor_exclusion(job, rules)
        if excluded:
            skipped.append(
                {
                    "ref": job_ref,
                    "site": site_match.site,
                    "reason": exclusion_reason,
                    "manual_review": "contractor",
                    "mode": "unallocated",
                }
            )
            continue

        ppm_allowed, ppm_reason = ppm_tech_diary_review(job, rules)
        if not ppm_allowed:
            skipped.append(
                {
                    "ref": job_ref,
                    "site": site_match.site,
                    "reason": ppm_reason,
                    "manual_review": "ppm",
                    "mode": "unallocated",
                }
            )
            continue

        try:
            result = build_recommendation(client, job, rules)
            if isinstance(result, tuple):
                skipped.append(
                    {
                        "ref": job_ref,
                        "site": site_match.site,
                        "reason": result[1],
                        "manual_review": "allocation",
                        "mode": "unallocated",
                    }
                )
                continue

            scheduled_day = dt.date.fromisoformat(result.proposed_date)
            start = dt.datetime.strptime(result.proposed_start, "%H:%M").time()
            end = dt.datetime.strptime(result.proposed_end, "%H:%M").time()
            resource = {"id": result.proposed_resource_id, "label": result.proposed_resource}
            reserved = reservations.get(result.proposed_resource_id, [])
            if slot_has_overlap(
                reserved,
                dt.datetime.combine(scheduled_day, start),
                dt.datetime.combine(scheduled_day, end),
            ):
                replacement = find_resource_slot(
                    client,
                    rules,
                    resource,
                    result.duration_minutes,
                    start_day=next_working_day(dt.date.today()),
                    extra_blocks=reserved,
                )
                if not replacement:
                    skipped.append(
                        {
                            "ref": job_ref,
                            "site": site_match.site,
                            "reason": "No suitable diary slot found after reserving earlier same-run allocations",
                            "manual_review": "capacity",
                            "mode": "unallocated",
                        }
                    )
                    continue
                scheduled_day, start, end, before, after = replacement
                result.proposed_date = scheduled_day.isoformat()
                result.proposed_start = start.strftime("%H:%M")
                result.proposed_end = end.strftime("%H:%M")
                result.booking_before = before
                result.booking_after = after

            verification = "dry run"
            if apply:
                scheduled_day, start, end, verification = schedule_with_verification(
                    client,
                    rules,
                    job_id=int(job["JobId"]),
                    job_ref=result.job_ref,
                    resource=resource,
                    scheduled_day=scheduled_day,
                    start=start,
                    end=end,
                    duration_minutes=result.duration_minutes,
                    extra_blocks=reservations.get(result.proposed_resource_id, []),
                )
                result.proposed_date = scheduled_day.isoformat()
                result.proposed_start = start.strftime("%H:%M")
                result.proposed_end = end.strftime("%H:%M")
                record = recommendation_record(
                    result,
                    job_id=int(job["JobId"]),
                    mode=confidence_mode(result.confidence),
                    verification=verification,
                    previously_audited=job_ref in audited_refs,
                )
                append_audit(record)
                audited_refs.add(job_ref)
            else:
                record = recommendation_record(
                    result,
                    job_id=int(job["JobId"]),
                    mode=confidence_mode(result.confidence),
                    verification=verification,
                    previously_audited=job_ref in audited_refs,
                )
            applied.append(record)
            add_reservation(
                reservations,
                result.proposed_resource_id,
                scheduled_day,
                start,
                end,
                f"SAME-RUN {result.job_ref}",
            )
        except Exception as exc:  # noqa: BLE001 - continue the daily batch
            failed.append({"ref": job_ref, "site": site_match.site, "error": str(exc), "mode": "unallocated"})

    return applied, skipped, failed, non_btr_count


def diary_stale_candidates(client: BigChangeClient, rules: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], int]:
    today = dt.date.today()
    start = today - dt.timedelta(days=LOOKBACK_DAYS)
    rows = client.jobs_list(
        {
            "Start": start.isoformat(),
            "End": (today - dt.timedelta(days=1)).isoformat(),
            "DateOptionId": 0,
            "Allocated": 1,
            "ExcludeNullPlannedDates": 1,
            "includeExtra": 1,
        },
        page_size=500,
    )

    stale_non_ppm: list[dict[str, Any]] = []
    stale_ppm: list[dict[str, Any]] = []
    non_btr_count = 0
    for job in rows:
        planned = parse_datetime(job.get("PlannedStart"))
        if not planned or planned.date() >= today:
            continue
        if is_closed_or_cancelled(job):
            continue
        status = normalise(job.get("Status"))
        if status and status not in OPEN_STATUS_LABELS:
            continue
        site, site_reason = site_for_diary_job(job, rules)
        if not site:
            non_btr_count += 1
            continue
        entry = {"job": job, "site": site, "site_reason": site_reason}
        if is_ppm_job(job):
            stale_ppm.append(entry)
        else:
            stale_non_ppm.append(entry)
    return stale_non_ppm, stale_ppm, non_btr_count


def process_stale_diary(
    client: BigChangeClient,
    rules: dict[str, Any],
    audited_refs: set[str],
    resources: list[dict[str, Any]],
    reservations: dict[int, list[tuple[dt.datetime, dt.datetime, str]]],
    *,
    apply: bool,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], int]:
    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    stale_non_ppm, stale_ppm, non_btr_count = diary_stale_candidates(client, rules)
    by_name = resources_by_name(resources)

    for item in stale_ppm:
        job = item["job"]
        skipped.append(
            {
                "ref": str(job.get("Ref") or ""),
                "site": item["site"],
                "reason": "Stale PPM diary entry requires manual review; not auto-rescheduled",
                "manual_review": "ppm_stale",
                "mode": "stale_diary",
            }
        )

    for item in stale_non_ppm:
        job = item["job"]
        job_ref = str(job.get("Ref") or "")
        if is_cover_job(job):
            skipped.append(
                {
                    "ref": job_ref,
                    "site": item["site"],
                    "reason": "Cover/agency job requires manual rota review; not auto-rescheduled",
                    "manual_review": "cover",
                    "mode": "stale_diary",
                }
            )
            continue

        if job_ref in audited_refs:
            skipped.append(
                {
                    "ref": job_ref,
                    "site": item["site"],
                    "reason": "Already present in allocation audit; not re-actioning stale diary entry",
                    "manual_review": "duplicate_audit",
                    "mode": "stale_diary",
                }
            )
            continue

        resource_name = str(job.get("Resource") or "")
        assigned = by_name.get(normalise(resource_name))
        if not assigned:
            skipped.append(
                {
                    "ref": job_ref,
                    "site": item["site"],
                    "reason": f"Assigned resource '{resource_name}' was not found in active resource list",
                    "manual_review": "resource",
                    "mode": "stale_diary",
                }
            )
            continue

        if not resource_is_active_for_jobwatch(assigned):
            skipped.append(
                {
                    "ref": job_ref,
                    "site": item["site"],
                    "reason": f"Assigned resource '{resource_name}' is inactive (Resource4Schedule=0); manual reassignment required",
                    "manual_review": "resource",
                    "mode": "stale_diary",
                }
            )
            continue

        if not is_site_role_resource(assigned, rules):
            skipped.append(
                {
                    "ref": job_ref,
                    "site": item["site"],
                    "reason": f"Assigned resource '{resource_name}' is active but is not a site-based Tech/CT/HK resource",
                    "manual_review": "resource",
                    "mode": "stale_diary",
                }
            )
            continue

        duration, duration_reason, duration_confidence = estimate_duration(job, rules)
        slot = find_resource_slot(
            client,
            rules,
            assigned,
            duration,
            start_day=next_working_day(dt.date.today()),
            extra_blocks=reservations.get(resource_id(assigned), []),
        )
        if not slot:
            skipped.append(
                {
                    "ref": job_ref,
                    "site": item["site"],
                    "reason": f"No suitable diary slot found for assigned resource '{resource_name}' within {SEARCH_DAYS} days",
                    "manual_review": "capacity",
                    "mode": "stale_diary",
                }
            )
            continue

        day, start, end, before, after = slot
        role = resource_role(resource_name, rules) or determine_role(job).role or "Tech"
        recommendation = Recommendation(
            job_ref=job_ref,
            job_id=int(job.get("JobId") or 0),
            site=item["site"],
            site_identification=item["site_reason"],
            description=str(job.get("Description") or "")[:500],
            status=str(job.get("Status") or ""),
            flags=str(job.get("CurrentFlag") or "None"),
            required_role=role,
            proposed_resource=resource_label(assigned),
            proposed_resource_id=resource_id(assigned),
            proposed_date=day.isoformat(),
            proposed_start=start.strftime("%H:%M"),
            proposed_end=end.strftime("%H:%M"),
            duration_minutes=duration,
            duration_reason=duration_reason,
            resource_reason=f"Kept existing assigned resource '{resource_name}' for incomplete non-PPM reschedule",
            contractor_check="Not checked for stale diary reschedule",
            ppm_check="Not a PPM job",
            overlap_check="Passed",
            booking_before=before,
            booking_after=after,
            priority=str(job.get("CurrentFlag") or job.get("Status") or "Routine"),
            target_date=str(job.get("DueDate") or "Not specified"),
            confidence=duration_confidence,
        )

        try:
            verification = "dry run"
            if apply:
                scheduled_day, scheduled_start, scheduled_end, verification = schedule_with_verification(
                    client,
                    rules,
                    job_id=int(job["JobId"]),
                    job_ref=job_ref,
                    resource=assigned,
                    scheduled_day=day,
                    start=start,
                    end=end,
                    duration_minutes=duration,
                    extra_blocks=reservations.get(resource_id(assigned), []),
                )
                recommendation.proposed_date = scheduled_day.isoformat()
                recommendation.proposed_start = scheduled_start.strftime("%H:%M")
                recommendation.proposed_end = scheduled_end.strftime("%H:%M")
                record = recommendation_record(
                    recommendation,
                    job_id=int(job["JobId"]),
                    mode="daily_incomplete_reschedule",
                    verification=verification,
                    original_date=str(job.get("PlannedStart") or ""),
                )
                append_audit(record)
                audited_refs.add(job_ref)
            else:
                record = recommendation_record(
                    recommendation,
                    job_id=int(job["JobId"]),
                    mode="daily_incomplete_reschedule",
                    verification=verification,
                    original_date=str(job.get("PlannedStart") or ""),
                )
            applied.append(record)
            add_reservation(
                reservations,
                recommendation.proposed_resource_id,
                dt.date.fromisoformat(recommendation.proposed_date),
                dt.datetime.strptime(recommendation.proposed_start, "%H:%M").time(),
                dt.datetime.strptime(recommendation.proposed_end, "%H:%M").time(),
                f"SAME-RUN {recommendation.job_ref}",
            )
        except Exception as exc:  # noqa: BLE001 - continue the daily batch
            failed.append({"ref": job_ref, "site": item["site"], "error": str(exc), "mode": "stale_diary"})

    return applied, skipped, failed, non_btr_count


def workload_warnings(client: BigChangeClient, rules: dict[str, Any], resources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    start = next_working_day(dt.date.today())
    end = start + dt.timedelta(days=SEARCH_DAYS)
    warnings: list[dict[str, Any]] = []
    for resource in resources:
        if not is_site_role_resource(resource, rules):
            continue
        diary = client.resource_diary(resource_id(resource), start, end)
        counts: Counter[dt.date] = Counter()
        for job in diary:
            if is_cancelled_diary_job(job):
                continue
            planned = parse_datetime(job.get("PlannedStart"))
            if planned:
                counts[planned.date()] += 1
        for day, count in sorted(counts.items()):
            if count >= 4:
                warnings.append({"resource": resource_label(resource), "date": day.isoformat(), "job_count": count})
    return warnings


def skipped_counts(skipped: list[dict[str, Any]]) -> dict[str, int]:
    counts: Counter[str] = Counter()
    for item in skipped:
        counts[str(item.get("manual_review") or "other")] += 1
    return dict(sorted(counts.items()))


def markdown_table(headers: list[str], rows: list[list[Any]]) -> str:
    if not rows:
        return "_None_\n"
    header = "| " + " | ".join(headers) + " |"
    separator = "| " + " | ".join("---" for _ in headers) + " |"
    body = ["| " + " | ".join(str(cell).replace("\n", " ") for cell in row) + " |" for row in rows]
    return "\n".join([header, separator, *body]) + "\n"


def write_summary(
    *,
    run_timestamp: dt.datetime,
    apply: bool,
    applied: list[dict[str, Any]],
    skipped: list[dict[str, Any]],
    failed: list[dict[str, Any]],
    warnings: list[dict[str, Any]],
    non_btr_unallocated: int,
    non_btr_stale: int,
) -> Path:
    path = SUMMARY_DIR / f"btr-daily-run-{run_timestamp.date().isoformat()}.md"
    manual = [item for item in skipped if item.get("manual_review") in {"ppm", "ppm_stale", "contractor", "resource", "allocation", "cover"}]
    low_confidence = [item for item in applied if str(item.get("confidence")) == "Low"]
    if low_confidence:
        for item in low_confidence:
            manual.append(
                {
                    "ref": item.get("job_ref"),
                    "site": item.get("site"),
                    "reason": "Low-confidence allocation was auto-applied; human review recommended",
                    "manual_review": "low_confidence",
                    "mode": item.get("mode"),
                }
            )

    content = [
        f"# BTR Daily Run - {run_timestamp.date().isoformat()}",
        "",
        f"**Run timestamp:** {run_timestamp.isoformat()}",
        f"**Mode:** {'apply' if apply else 'dry-run'}",
        "",
        "## Counts",
        "",
        f"- Applied: {len(applied)}",
        f"- Failed: {len(failed)}",
        f"- Skipped: {len(skipped)}",
        f"- Skipped by reason: `{json.dumps(skipped_counts(skipped), sort_keys=True)}`",
        f"- Non-BTR unallocated ignored: {non_btr_unallocated}",
        f"- Non-BTR stale diary ignored: {non_btr_stale}",
        "",
        "## Applied jobs",
        "",
        markdown_table(
            ["Ref", "Site", "Resource", "Date", "Start-End", "Confidence", "Mode"],
            [
                [
                    item.get("job_ref"),
                    item.get("site"),
                    item.get("resource"),
                    item.get("scheduled_date"),
                    f"{item.get('start')}-{item.get('end')}",
                    item.get("confidence"),
                    item.get("mode"),
                ]
                for item in applied
            ],
        ),
        "",
        "## Skipped jobs",
        "",
        markdown_table(
            ["Ref", "Site", "Reason", "Mode"],
            [[item.get("ref"), item.get("site"), item.get("reason"), item.get("mode")] for item in skipped],
        ),
        "",
        "## Failed jobs",
        "",
        markdown_table(
            ["Ref", "Site", "Error", "Mode"],
            [[item.get("ref"), item.get("site"), item.get("error"), item.get("mode")] for item in failed],
        ),
        "",
        "## Workload warnings",
        "",
        markdown_table(
            ["Resource", "Date", "Job count"],
            [[item.get("resource"), item.get("date"), item.get("job_count")] for item in warnings],
        ),
        "",
        "## Manual review",
        "",
        markdown_table(
            ["Ref", "Site", "Reason", "Category"],
            [[item.get("ref"), item.get("site"), item.get("reason"), item.get("manual_review")] for item in manual],
        ),
        "",
    ]
    path.write_text("\n".join(content), encoding="utf-8")
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the daily BigChange BTR allocation workflow")
    parser.add_argument("--apply", action="store_true", help="Write eligible schedules to BigChange and append audit rows")
    args = parser.parse_args()

    run_timestamp = utc_now()
    rules = load_rules()
    client = BigChangeClient()
    resources = client.resources()
    audited_refs = load_audited_refs()
    reservations: dict[int, list[tuple[dt.datetime, dt.datetime, str]]] = defaultdict(list)

    stale_applied, stale_skipped, stale_failed, non_btr_stale = process_stale_diary(
        client,
        rules,
        audited_refs,
        resources,
        reservations,
        apply=args.apply,
    )
    unallocated_applied, unallocated_skipped, unallocated_failed, non_btr_unallocated = process_unallocated(
        client,
        rules,
        audited_refs,
        reservations,
        apply=args.apply,
    )

    applied = [*stale_applied, *unallocated_applied]
    skipped = [*stale_skipped, *unallocated_skipped]
    failed = [*stale_failed, *unallocated_failed]
    warnings = workload_warnings(client, rules, resources)
    summary_path = write_summary(
        run_timestamp=run_timestamp,
        apply=args.apply,
        applied=applied,
        skipped=skipped,
        failed=failed,
        warnings=warnings,
        non_btr_unallocated=non_btr_unallocated,
        non_btr_stale=non_btr_stale,
    )
    print(
        json.dumps(
            {
                "mode": "apply" if args.apply else "dry-run",
                "applied": len(applied),
                "failed": len(failed),
                "skipped": len(skipped),
                "summary": str(summary_path.relative_to(ROOT)),
                "skipped_by_reason": skipped_counts(skipped),
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
