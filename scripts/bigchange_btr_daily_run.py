#!/usr/bin/env python3
"""Daily BTR allocation runner for the BigChange TEST environment.

This script discovers current 14-day BTR work, reschedules stale non-PPM diary
jobs, allocates eligible unassigned jobs, verifies diary placement after each
write, and writes the daily markdown summary required by the automation.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import sys
from dataclasses import dataclass
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
    choose_resource,
    contractor_exclusion,
    diary_blocks,
    estimate_duration,
    fetch_unallocated_jobs,
    format_working_hours,
    identify_site,
    is_cancelled_diary_job,
    is_ppm_job,
    is_unallocated,
    load_rules,
    normalise,
    parse_datetime,
    parse_duration,
    ppm_tech_diary_review,
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


@dataclass
class BtrResource:
    resource_id: int
    name: str
    site: str
    role: str
    active: bool


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def fetch_job(client: BigChangeClient, *, job_id: int | None = None, job_ref: str | None = None) -> dict[str, Any] | None:
    params: dict[str, Any] = {}
    if job_id:
        params["JobId"] = job_id
    elif job_ref:
        params["JobRef"] = job_ref
    else:
        return None
    payload = client.get("Job", params)
    if payload.get("Code") not in (0, None):
        return None
    result = payload.get("Result")
    if isinstance(result, list) and result:
        first = result[0]
        return first if isinstance(first, dict) else None
    return result if isinstance(result, dict) else None


def load_audit_records() -> list[dict[str, Any]]:
    if not AUDIT_PATH.exists():
        return []
    records: list[dict[str, Any]] = []
    for line in AUDIT_PATH.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        records.append(json.loads(line))
    return records


def append_audit(record: dict[str, Any]) -> None:
    AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with AUDIT_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")


def btr_resources(resources: list[dict[str, Any]], rules: dict[str, Any]) -> dict[int, BtrResource]:
    found: dict[int, BtrResource] = {}
    for resource in resources:
        name = str(resource.get("label") or "")
        active = resource_is_active_for_jobwatch(resource)
        if not active or resource_is_excluded(name, rules):
            continue
        site = resource_site(name, rules)
        role = resource_role(name, rules)
        resource_id = as_int(resource.get("id"))
        if not site or not role or resource_id is None:
            continue
        found[resource_id] = BtrResource(
            resource_id=resource_id,
            name=name,
            site=site,
            role=role,
            active=active,
        )
    return found


def status_is_open(job: dict[str, Any]) -> bool:
    status_id = as_int(job.get("StatusId"))
    if status_id in CLOSED_STATUS_IDS:
        return False
    return not is_cancelled_diary_job(job)


def duration_for_reschedule(job: dict[str, Any], rules: dict[str, Any]) -> tuple[int, str, str]:
    existing = parse_duration(job.get("Duration"))
    if existing:
        minimum = int(rules.get("duration_minutes", {}).get("min", 60))
        return max(existing, minimum), f"Kept existing diary duration ({existing} min)", "High"
    return estimate_duration(job, rules)


def discover_stale_diary_jobs(
    client: BigChangeClient,
    resources_by_id: dict[int, BtrResource],
    today: dt.date,
) -> list[dict[str, Any]]:
    start = today - dt.timedelta(days=LOOKBACK_DAYS)
    discovered: dict[tuple[str, int], dict[str, Any]] = {}
    for resource in resources_by_id.values():
        diary = client.resource_diary(resource.resource_id, start, today)
        for job in diary:
            planned = parse_datetime(job.get("PlannedStart"))
            if not planned or planned.date() >= today:
                continue
            if planned.date() < start or not status_is_open(job):
                continue
            ref = str(job.get("Ref") or "")
            job_id = as_int(job.get("JobId"), 0) or 0
            key = (ref, job_id)
            if key in discovered:
                continue
            discovered[key] = {
                "job": job,
                "resource": resource,
                "planned": planned,
            }
    return sorted(discovered.values(), key=lambda item: (item["planned"], str(item["job"].get("Ref") or "")))


def verify_schedule(
    client: BigChangeClient,
    job_id: int,
    job_ref: str,
    resource: BtrResource,
    start: dt.datetime,
    end: dt.datetime,
) -> tuple[bool, str]:
    job = fetch_job(client, job_id=job_id)
    if not job:
        return False, "Job API verification failed: job not returned"

    planned_start = parse_datetime(job.get("PlannedStart"))
    resource_label = normalise(job.get("Resource"))
    explicit_resource_id = (
        as_int(job.get("ResourceId"))
        or as_int(job.get("ResourceID"))
        or as_int(job.get("ResId"))
        or as_int(job.get("ResourceId1"))
    )
    planned_ok = bool(planned_start and planned_start == start)
    resource_ok = explicit_resource_id == resource.resource_id if explicit_resource_id else bool(resource_label)
    if not planned_ok:
        return False, f"Job API verification failed: planned start is {job.get('PlannedStart')}"
    if not resource_ok:
        return False, "Job API verification failed: resource missing after schedule"

    diary = client.resource_diary(resource.resource_id, start.date(), start.date())
    matching = [
        entry
        for entry in diary
        if as_int(entry.get("JobId")) == job_id or str(entry.get("Ref") or "") == job_ref
    ]
    if not matching:
        return False, "Resource diary verification failed: job not present on intended diary"

    for entry in diary:
        if is_cancelled_diary_job(entry):
            continue
        if as_int(entry.get("JobId")) == job_id or str(entry.get("Ref") or "") == job_ref:
            continue
        entry_start = parse_datetime(entry.get("PlannedStart"))
        if not entry_start or entry_start.date() != start.date():
            continue
        entry_end = parse_datetime(entry.get("PlannedEnd"))
        if not entry_end:
            entry_duration = parse_duration(entry.get("Duration")) or 60
            entry_end = entry_start + dt.timedelta(minutes=entry_duration)
        if start < entry_end and end > entry_start:
            label = f"{entry.get('Ref')} {entry_start.strftime('%H:%M')}-{entry_end.strftime('%H:%M')}"
            return False, f"Scheduled slot overlaps existing diary booking: {label}"
    return True, "Verified on Job API and resource diary with no overlaps"


def schedule_and_verify(
    client: BigChangeClient,
    job_id: int,
    job_ref: str,
    resource: BtrResource,
    scheduled_date: str,
    start_time: str,
    end_time: str,
    duration_minutes: int,
) -> tuple[bool, str]:
    start = dt.datetime.strptime(f"{scheduled_date} {start_time}:00", "%Y-%m-%d %H:%M:%S")
    end = dt.datetime.strptime(f"{scheduled_date} {end_time}:00", "%Y-%m-%d %H:%M:%S")
    client.schedule_job(job_id, resource.resource_id, start.strftime("%Y-%m-%d %H:%M:%S"), duration_minutes)
    ok, message = verify_schedule(client, job_id, job_ref, resource, start, end)
    if ok:
        return ok, message

    if "resource missing" in message or "not present on intended diary" in message:
        client.schedule_job(job_id, resource.resource_id, start.strftime("%Y-%m-%d %H:%M:%S"), duration_minutes)
        retry_ok, retry_message = verify_schedule(client, job_id, job_ref, resource, start, end)
        return retry_ok, f"{message}; retry: {retry_message}"
    return ok, message


def append_applied_record(
    result: dict[str, Any],
    *,
    mode: str,
    verification: str,
    original_date: str | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    record = {
        "timestamp": utc_now(),
        "job_ref": result["ref"],
        "job_id": result["job_id"],
        "site": result["site"],
        "resource": result["resource"],
        "resource_id": result["resource_id"],
        "scheduled_date": result["scheduled_date"],
        "start": result["start"],
        "end": result["end"],
        "duration_minutes": result["duration_minutes"],
        "confidence": result["confidence"],
        "mode": mode,
        "overlap_check": "Passed",
        "verification": verification,
    }
    if original_date:
        record["original_date"] = original_date
    if note:
        record["note"] = note
    append_audit(record)
    return record


def build_reschedule_result(
    client: BigChangeClient,
    rules: dict[str, Any],
    job: dict[str, Any],
    assigned: BtrResource,
) -> tuple[dict[str, Any] | None, str]:
    duration, duration_reason, duration_confidence = duration_for_reschedule(job, rules)
    required_role = assigned.role
    resource, slot, warnings = choose_resource(
        client,
        assigned.site,
        required_role,
        duration,
        rules,
        preferred_resource=assigned.name,
    )
    if not resource or not slot:
        return None, "; ".join(warnings)

    diary = client.resource_diary(resource.resource_id, slot.date, slot.date)
    blocks = diary_blocks([entry for entry in diary if not is_cancelled_diary_job(entry)], slot.date)
    slot_start = dt.datetime.combine(slot.date, slot.start)
    slot_end = dt.datetime.combine(slot.date, slot.end)
    if slot_has_overlap(blocks, slot_start, slot_end):
        return None, "Proposed reschedule slot overlaps an existing planned diary booking"
    before, after = adjacent_bookings(blocks, slot_start, slot_end)
    confidence = "High" if duration_confidence == "High" else "Medium"
    return (
        {
            "ref": str(job.get("Ref") or ""),
            "job_id": as_int(job.get("JobId"), 0) or 0,
            "site": assigned.site,
            "resource": resource.name,
            "resource_id": resource.resource_id,
            "role": required_role,
            "scheduled_date": slot.date.isoformat(),
            "start": slot.start.strftime("%H:%M"),
            "end": slot.end.strftime("%H:%M"),
            "duration_minutes": slot.duration_minutes,
            "confidence": confidence,
            "duration_reason": duration_reason,
            "resource_reason": (
                f"Kept assigned active resource {resource.name}; working hours "
                f"{format_working_hours(resource_working_windows(client, resource.resource_id, slot.date, {}, rules))}"
            ),
            "booking_before": before,
            "booking_after": after,
            "warnings": warnings,
        },
        "",
    )


def recommendation_to_result(recommendation: Recommendation) -> dict[str, Any]:
    return {
        "ref": recommendation.job_ref,
        "job_id": recommendation.job_id,
        "site": recommendation.site,
        "resource": recommendation.proposed_resource,
        "resource_id": recommendation.proposed_resource_id,
        "role": recommendation.required_role,
        "scheduled_date": recommendation.proposed_date,
        "start": recommendation.proposed_start,
        "end": recommendation.proposed_end,
        "duration_minutes": recommendation.duration_minutes,
        "confidence": recommendation.confidence,
        "duration_reason": recommendation.duration_reason,
        "resource_reason": recommendation.resource_reason,
        "booking_before": recommendation.booking_before,
        "booking_after": recommendation.booking_after,
        "warnings": recommendation.assumptions,
    }


def process_reschedules(
    client: BigChangeClient,
    rules: dict[str, Any],
    stale_items: list[dict[str, Any]],
    audited_refs: set[str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    manual: list[dict[str, Any]] = []

    for item in stale_items:
        job = item["job"]
        assigned = item["resource"]
        planned = item["planned"]
        ref = str(job.get("Ref") or "")
        if is_ppm_job(job):
            reason = "Stale PPM diary entry requires manual review; not auto-rescheduled"
            skipped.append({"ref": ref, "reason": reason})
            manual.append({"ref": ref, "reason": reason, "site": assigned.site})
            continue
        if ref in audited_refs:
            fresh = fetch_job(client, job_id=as_int(job.get("JobId")))
            if not (fresh and is_unallocated(fresh)):
                skipped.append({"ref": ref, "reason": "Already actioned in allocation audit"})
                continue

        full_job = fetch_job(client, job_id=as_int(job.get("JobId"))) or job
        result, reason = build_reschedule_result(client, rules, full_job, assigned)
        if not result:
            failed.append({"ref": ref, "error": reason or "No reschedule result produced"})
            continue

        resource = BtrResource(
            resource_id=result["resource_id"],
            name=result["resource"],
            site=result["site"],
            role=result["role"],
            active=True,
        )
        ok, verification = schedule_and_verify(
            client,
            result["job_id"],
            result["ref"],
            resource,
            result["scheduled_date"],
            result["start"],
            result["end"],
            result["duration_minutes"],
        )
        if not ok:
            failed.append({"ref": ref, "error": verification})
            continue

        audit = append_applied_record(
            result,
            mode="daily_incomplete_reschedule",
            verification=verification,
            original_date=planned.date().isoformat(),
        )
        applied.append({**result, **audit})
    return applied, skipped, failed, manual


def process_unallocated(
    client: BigChangeClient,
    rules: dict[str, Any],
    jobs: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    manual: list[dict[str, Any]] = []

    for job in sorted(jobs, key=lambda row: str(row.get("Ref") or "")):
        ref = str(job.get("Ref") or "")
        site_match = identify_site(job, rules)
        if not site_match:
            continue

        current_flag = normalise(job.get("CurrentFlag"))
        if "cancel" in current_flag:
            reason = f"Current flag indicates cancellation/manual stop: {job.get('CurrentFlag')}"
            skipped.append({"ref": ref, "reason": reason})
            manual.append({"ref": ref, "reason": reason, "site": site_match.site})
            continue

        excluded, exclusion_reason = contractor_exclusion(job, rules)
        if excluded:
            skipped.append({"ref": ref, "reason": exclusion_reason})
            manual.append({"ref": ref, "reason": exclusion_reason, "site": site_match.site})
            continue

        ppm_allowed, ppm_reason = ppm_tech_diary_review(job, rules)
        if not ppm_allowed:
            skipped.append({"ref": ref, "reason": ppm_reason})
            manual.append({"ref": ref, "reason": ppm_reason, "site": site_match.site})
            continue

        recommendation = build_recommendation(client, job, rules)
        if isinstance(recommendation, tuple):
            skipped.append({"ref": ref, "reason": recommendation[1]})
            manual.append({"ref": ref, "reason": recommendation[1], "site": site_match.site})
            continue

        result = recommendation_to_result(recommendation)
        resource = BtrResource(
            resource_id=result["resource_id"],
            name=result["resource"],
            site=result["site"],
            role=result["role"],
            active=True,
        )
        ok, verification = schedule_and_verify(
            client,
            result["job_id"],
            result["ref"],
            resource,
            result["scheduled_date"],
            result["start"],
            result["end"],
            result["duration_minutes"],
        )
        if not ok:
            failed.append({"ref": ref, "error": verification})
            continue

        mode = f"daily_allocate_{recommendation.confidence.lower()}"
        audit = append_applied_record(result, mode=mode, verification=verification)
        applied.append({**result, **audit})
        if recommendation.confidence == "Low":
            manual.append({"ref": ref, "reason": "Low-confidence allocation applied; human review recommended", "site": result["site"]})
    return applied, skipped, failed, manual


def workload_warnings(client: BigChangeClient, applied: list[dict[str, Any]]) -> list[dict[str, Any]]:
    touched = {
        (as_int(item.get("resource_id")), str(item.get("resource") or ""), dt.date.fromisoformat(item["scheduled_date"]))
        for item in applied
        if item.get("resource_id") and item.get("scheduled_date")
    }
    warnings: list[dict[str, Any]] = []
    for resource_id, resource_name, day in sorted(touched, key=lambda item: (item[2], item[1])):
        if resource_id is None:
            continue
        diary = client.resource_diary(resource_id, day, day)
        jobs = [
            job
            for job in diary
            if not is_cancelled_diary_job(job)
            and parse_datetime(job.get("PlannedStart"))
            and parse_datetime(job.get("PlannedStart")).date() == day
        ]
        if len(jobs) >= 4:
            warnings.append(
                {
                    "resource": resource_name,
                    "date": day.isoformat(),
                    "job_count": len(jobs),
                    "refs": ", ".join(str(job.get("Ref") or "") for job in jobs),
                }
            )
    return warnings


def count_by_reason(skipped: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = collections.Counter(item.get("reason", "Unknown") for item in skipped)
    return dict(sorted(counts.items(), key=lambda item: (-item[1], item[0])))


def markdown_table(headers: list[str], rows: list[list[Any]]) -> str:
    if not rows:
        return "_None._"
    lines = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    for row in rows:
        lines.append("| " + " | ".join(str(cell).replace("\n", " ") for cell in row) + " |")
    return "\n".join(lines)


def write_summary(
    run_date: dt.date,
    started_at: str,
    applied: list[dict[str, Any]],
    skipped: list[dict[str, Any]],
    failed: list[dict[str, Any]],
    manual: list[dict[str, Any]],
    warnings: list[dict[str, Any]],
) -> Path:
    applied_rows = [
        [
            item.get("job_ref") or item.get("ref"),
            item.get("site"),
            item.get("resource"),
            item.get("scheduled_date"),
            f"{item.get('start')}-{item.get('end')}",
            item.get("confidence"),
            item.get("mode"),
        ]
        for item in applied
    ]
    skipped_rows = [[item.get("ref"), item.get("reason")] for item in skipped]
    failed_rows = [[item.get("ref"), item.get("error")] for item in failed]
    warning_rows = [[item["resource"], item["date"], item["job_count"], item["refs"]] for item in warnings]
    manual_rows = [[item.get("ref"), item.get("site", ""), item.get("reason")] for item in manual]
    reason_counts = count_by_reason(skipped)
    reason_lines = "\n".join(f"- {reason}: {count}" for reason, count in reason_counts.items()) or "- None"

    content = f"""# BTR Daily Allocation Run — {run_date.isoformat()}

**Run timestamp:** {started_at}  
**Environment:** BigChange TEST  
**Lookback:** {LOOKBACK_DAYS} days for unallocated jobs and incomplete diary jobs

## Counts

| Applied | Failed | Skipped |
|---:|---:|---:|
| {len(applied)} | {len(failed)} | {len(skipped)} |

### Skipped by reason

{reason_lines}

## Applied jobs

{markdown_table(["Ref", "Site", "Resource", "Date", "Start-End", "Confidence", "Mode"], applied_rows)}

## Skipped jobs

{markdown_table(["Ref", "Reason"], skipped_rows)}

## Failed jobs

{markdown_table(["Ref", "Error"], failed_rows)}

## Workload warnings

{markdown_table(["Resource", "Date", "Job count", "Refs"], warning_rows)}

## Manual review

{markdown_table(["Ref", "Site", "Reason"], manual_rows)}
"""
    path = SUMMARY_DIR / f"btr-daily-run-{run_date.isoformat()}.md"
    path.write_text(content, encoding="utf-8")
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description="Run daily BTR allocation workflow")
    parser.add_argument("--dry-run", action="store_true", help="Discover candidates only; do not write to BigChange or audit")
    args = parser.parse_args()

    started_at = utc_now()
    today = dt.date.today()
    rules = load_rules()
    client = BigChangeClient()
    resources = client.resources()
    resources_by_id = btr_resources(resources, rules)
    audited_refs = {str(record.get("job_ref") or "") for record in load_audit_records()}

    stale_items = discover_stale_diary_jobs(client, resources_by_id, today)
    unallocated_jobs = fetch_unallocated_jobs(client, LOOKBACK_DAYS)

    if args.dry_run:
        btr_unallocated = [job for job in unallocated_jobs if identify_site(job, rules)]
        print(
            json.dumps(
                {
                    "run_timestamp": started_at,
                    "stale_diary_candidates": len(stale_items),
                    "unallocated_btr_candidates": len(btr_unallocated),
                    "audited_refs": len(audited_refs),
                    "active_btr_resources": len(resources_by_id),
                },
                indent=2,
            )
        )
        return 0

    applied_reschedules, skipped_reschedules, failed_reschedules, manual_reschedules = process_reschedules(
        client,
        rules,
        stale_items,
        audited_refs,
    )
    applied_allocations, skipped_allocations, failed_allocations, manual_allocations = process_unallocated(
        client,
        rules,
        unallocated_jobs,
    )

    applied = applied_reschedules + applied_allocations
    skipped = skipped_reschedules + skipped_allocations
    failed = failed_reschedules + failed_allocations
    manual = manual_reschedules + manual_allocations
    warnings = workload_warnings(client, applied)
    summary_path = write_summary(today, started_at, applied, skipped, failed, manual, warnings)
    print(
        json.dumps(
            {
                "summary": str(summary_path.relative_to(ROOT)),
                "applied": len(applied),
                "failed": len(failed),
                "skipped": len(skipped),
                "manual_review": len(manual),
                "workload_warnings": len(warnings),
            },
            indent=2,
        )
    )
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
