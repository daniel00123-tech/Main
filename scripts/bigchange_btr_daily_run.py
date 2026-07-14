#!/usr/bin/env python3
"""Daily Build-to-Rent allocation runner for the BigChange TEST environment."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from bigchange_btr_allocation import (  # noqa: E402
    BigChangeClient,
    CLOSED_STATUS_IDS,
    adjacent_bookings,
    as_int,
    build_recommendation,
    contractor_exclusion,
    diary_blocks,
    estimate_duration,
    fetch_unallocated_jobs,
    find_slot,
    identify_site,
    is_cancelled_diary_job,
    is_ppm_job,
    load_rules,
    normalise,
    parse_datetime,
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
SEARCH_DAYS = 14
LOW_REVIEW_NOTE = "Low-confidence allocation applied; review job details and allocated slot"


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def load_audit_refs() -> set[str]:
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


def fetch_job(client: BigChangeClient, *, job_id: int | None = None, job_ref: str | None = None) -> dict[str, Any] | None:
    params: dict[str, Any] = {}
    if job_id is not None:
        params["JobId"] = job_id
    elif job_ref:
        params["JobRef"] = job_ref
    else:
        return None
    payload = client.get("Job", params)
    if payload.get("Code") not in (0, None):
        return None
    rows = client.rows(payload)
    return rows[0] if rows else None


def has_cancel_flag(job: dict[str, Any]) -> bool:
    flag = normalise(job.get("CurrentFlag"))
    return "cancel" in flag or "cancelled" in flag


def is_open_diary_job(job: dict[str, Any]) -> bool:
    if is_cancelled_diary_job(job):
        return False
    if as_int(job.get("StatusId")) in CLOSED_STATUS_IDS:
        return False
    status = normalise(job.get("Status"))
    return status not in {"completed", "complete", "cancelled", "deleted", "rejected"}


def resource_maps(resources: list[dict[str, Any]], rules: dict[str, Any]) -> tuple[dict[int, dict[str, Any]], dict[str, dict[str, Any]]]:
    by_id: dict[int, dict[str, Any]] = {}
    by_name: dict[str, dict[str, Any]] = {}
    for resource in resources:
        resource_id = as_int(resource.get("id"))
        name = str(resource.get("label") or "")
        if resource_id is None or not name:
            continue
        by_id[resource_id] = resource
        by_name[normalise(name)] = resource
    return by_id, by_name


def active_btr_resources(resources: list[dict[str, Any]], rules: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for resource in resources:
        name = str(resource.get("label") or "")
        if not resource_is_active_for_jobwatch(resource):
            continue
        if resource_is_excluded(name, rules):
            continue
        if not resource_site(name, rules):
            continue
        if not resource_role(name, rules):
            continue
        result.append(resource)
    return result


def resource_for_diary_job(job: dict[str, Any], by_name: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    name = normalise(job.get("Resource"))
    if not name:
        return None
    if name in by_name:
        return by_name[name]
    for key, resource in by_name.items():
        if name in key or key in name:
            return resource
    return None


def table(headers: list[str], rows: list[list[Any]]) -> str:
    if not rows:
        return "_None._"
    rendered = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    for row in rows:
        rendered.append("| " + " | ".join(str(cell).replace("\n", " ") for cell in row) + " |")
    return "\n".join(rendered)


def build_reschedule(
    client: BigChangeClient,
    job: dict[str, Any],
    resource: dict[str, Any],
    rules: dict[str, Any],
) -> tuple[dict[str, Any] | None, str | None]:
    resource_id = as_int(resource.get("id"))
    resource_name = str(resource.get("label") or "")
    site = resource_site(resource_name, rules)
    role = resource_role(resource_name, rules)
    if resource_id is None or not site or not role:
        return None, "Assigned resource is not an active site-based Tech/CT/HK resource"

    if not resource_is_active_for_jobwatch(resource):
        return None, "Assigned resource is inactive for JobWatch scheduling"
    if resource_is_excluded(resource_name, rules):
        return None, "Assigned resource is excluded by resource rules"

    duration, duration_reason, duration_confidence = estimate_duration(job, rules)
    start_day = dt.date.today()
    while start_day.weekday() >= 5:
        start_day += dt.timedelta(days=1)
    end_day = start_day + dt.timedelta(days=SEARCH_DAYS)
    diary = client.resource_diary(resource_id, start_day, end_day)
    schedule_jobs = [entry for entry in diary if not is_cancelled_diary_job(entry)]
    working_hours_cache: dict[int, list[dict[str, Any]]] = {}

    for offset in range(SEARCH_DAYS + 1):
        day = start_day + dt.timedelta(days=offset)
        if day.weekday() >= 5:
            continue
        windows = resource_working_windows(client, resource_id, day, working_hours_cache, rules)
        if not windows:
            continue
        blocks = diary_blocks(schedule_jobs, day)
        slot = find_slot(blocks, day, duration, windows)
        if not slot:
            continue
        slot_start = dt.datetime.combine(slot.date, slot.start)
        slot_end = dt.datetime.combine(slot.date, slot.end)
        if slot_has_overlap(blocks, slot_start, slot_end):
            continue
        before, after = adjacent_bookings(blocks, slot_start, slot_end)
        return {
            "job_ref": str(job.get("Ref") or ""),
            "job_id": int(job.get("JobId") or 0),
            "site": site,
            "resource": resource_name,
            "resource_id": resource_id,
            "scheduled_date": slot.date.isoformat(),
            "start": slot.start.strftime("%H:%M"),
            "end": slot.end.strftime("%H:%M"),
            "duration_minutes": slot.duration_minutes,
            "confidence": duration_confidence,
            "overlap_check": "Passed",
            "booking_before": before,
            "booking_after": after,
            "duration_reason": duration_reason,
            "role": role,
        }, None

    return None, "No suitable diary slot found within search window"


def verify_scheduled_job(
    client: BigChangeClient,
    *,
    job_id: int,
    job_ref: str,
    resource_id: int,
    resource_name: str,
    scheduled_date: str,
    start: str,
    end: str,
) -> tuple[bool, str]:
    day = dt.date.fromisoformat(scheduled_date)
    expected_start = dt.datetime.strptime(f"{scheduled_date} {start}", "%Y-%m-%d %H:%M")
    expected_end = dt.datetime.strptime(f"{scheduled_date} {end}", "%Y-%m-%d %H:%M")
    diary = client.resource_diary(resource_id, day, day)
    schedule_jobs = [entry for entry in diary if not is_cancelled_diary_job(entry)]
    matches = [
        entry
        for entry in schedule_jobs
        if as_int(entry.get("JobId")) == job_id or str(entry.get("Ref") or "") == job_ref
    ]
    if not matches:
        fetched = fetch_job(client, job_id=job_id)
        planned = parse_datetime(fetched.get("PlannedStart")) if fetched else None
        resource = normalise(fetched.get("Resource")) if fetched else ""
        if planned and planned == expected_start and not resource:
            return False, "Job has planned start but no resource after schedule"
        return False, "Job not found on intended resource diary after schedule"

    actual = matches[0]
    actual_start = parse_datetime(actual.get("PlannedStart"))
    actual_end = parse_datetime(actual.get("PlannedEnd"))
    if actual_start != expected_start:
        return False, f"Diary start mismatch: expected {expected_start}, got {actual.get('PlannedStart')}"
    if actual_end and actual_end != expected_end:
        return False, f"Diary end mismatch: expected {expected_end}, got {actual.get('PlannedEnd')}"

    blocks = diary_blocks(schedule_jobs, day)
    for block_start, block_end, label in blocks:
        if job_ref in label:
            continue
        if slot_has_overlap([(block_start, block_end, label)], expected_start, expected_end):
            return False, f"Scheduled job overlaps {label}"

    fetched = fetch_job(client, job_id=job_id)
    if fetched:
        fetched_resource = normalise(fetched.get("Resource"))
        if fetched_resource and normalise(resource_name) not in fetched_resource and fetched_resource not in normalise(resource_name):
            return False, f"Job resource mismatch after schedule: {fetched.get('Resource')}"

    return True, "Verified on intended resource diary with no overlap involving scheduled job"


def schedule_record(client: BigChangeClient, record: dict[str, Any], *, apply: bool, mode: str) -> tuple[bool, str]:
    if not apply:
        return True, "Dry run: not written to BigChange"
    schedule_dt = f"{record['scheduled_date']} {record['start']}:00"
    client.schedule_job(int(record["job_id"]), int(record["resource_id"]), schedule_dt, int(record["duration_minutes"]))
    ok, message = verify_scheduled_job(
        client,
        job_id=int(record["job_id"]),
        job_ref=str(record["job_ref"]),
        resource_id=int(record["resource_id"]),
        resource_name=str(record["resource"]),
        scheduled_date=str(record["scheduled_date"]),
        start=str(record["start"]),
        end=str(record["end"]),
    )
    if not ok and "no resource" in message.lower():
        client.schedule_job(int(record["job_id"]), int(record["resource_id"]), schedule_dt, int(record["duration_minutes"]))
        ok, message = verify_scheduled_job(
            client,
            job_id=int(record["job_id"]),
            job_ref=str(record["job_ref"]),
            resource_id=int(record["resource_id"]),
            resource_name=str(record["resource"]),
            scheduled_date=str(record["scheduled_date"]),
            start=str(record["start"]),
            end=str(record["end"]),
        )
    if not ok:
        return False, message

    audit_record = {
        "timestamp": utc_now(),
        "job_ref": record["job_ref"],
        "job_id": record["job_id"],
        "site": record["site"],
        "resource": record["resource"],
        "resource_id": record["resource_id"],
        "scheduled_date": record["scheduled_date"],
        "start": record["start"],
        "end": record["end"],
        "duration_minutes": record["duration_minutes"],
        "confidence": record.get("confidence", "Medium"),
        "mode": mode,
        "overlap_check": record.get("overlap_check", "Passed"),
    }
    if record.get("original_date"):
        audit_record["original_date"] = record["original_date"]
    append_audit(audit_record)
    return True, message


def process_stale_diary(
    client: BigChangeClient,
    rules: dict[str, Any],
    resources: list[dict[str, Any]],
    audit_refs: set[str],
    *,
    apply: bool,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    _, by_name = resource_maps(resources, rules)
    start = dt.date.today() - dt.timedelta(days=LOOKBACK_DAYS)
    end = dt.date.today() - dt.timedelta(days=1)
    seen: set[int] = set()

    for resource in active_btr_resources(resources, rules):
        resource_id = int(resource["id"])
        diary = client.resource_diary(resource_id, start, end)
        for job in diary:
            job_id = as_int(job.get("JobId"))
            if job_id is None or job_id in seen:
                continue
            planned = parse_datetime(job.get("PlannedStart"))
            if not planned or planned.date() < start or planned.date() > end:
                continue
            if not is_open_diary_job(job):
                continue
            if not resource_site(str(job.get("Resource") or resource.get("label") or ""), rules):
                continue
            seen.add(job_id)
            ref = str(job.get("Ref") or "")

            if ref in audit_refs:
                skipped.append({"ref": ref, "reason": "Already actioned in allocation audit; still assigned/planned, manual review"})
                continue
            if has_cancel_flag(job):
                skipped.append({"ref": ref, "reason": "CurrentFlag contains cancel wording; manual review"})
                continue
            if is_ppm_job(job):
                skipped.append({"ref": ref, "reason": "Stale PPM diary entry; manual review only"})
                continue

            assigned_resource = resource_for_diary_job(job, by_name) or resource
            proposal, error = build_reschedule(client, job, assigned_resource, rules)
            if not proposal:
                failed.append({"ref": ref, "error": error or "Unable to build reschedule proposal"})
                continue
            proposal["original_date"] = planned.date().isoformat()
            ok, message = schedule_record(client, proposal, apply=apply, mode="daily_incomplete_reschedule")
            if ok:
                applied.append({**proposal, "mode": "daily_incomplete_reschedule", "verification": message})
                audit_refs.add(ref)
            else:
                failed.append({"ref": ref, "error": message})

    return applied, skipped, failed


def process_unallocated(
    client: BigChangeClient,
    rules: dict[str, Any],
    audit_refs: set[str],
    *,
    apply: bool,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    manual_review: list[dict[str, Any]] = []
    jobs = fetch_unallocated_jobs(client, LOOKBACK_DAYS)

    for job in sorted(jobs, key=lambda item: str(item.get("Ref") or "")):
        ref = str(job.get("Ref") or "")
        site_match = identify_site(job, rules)
        if not site_match:
            continue
        if ref in audit_refs:
            manual_review.append({"ref": ref, "reason": "Previously actioned job is unallocated again; reprocessed by daily run"})
        if has_cancel_flag(job):
            skipped.append({"ref": ref, "reason": "CurrentFlag contains cancel wording; manual review", "site": site_match.site})
            manual_review.append({"ref": ref, "reason": "Cancel-flagged unallocated BTR job"})
            continue
        excluded, exclusion_reason = contractor_exclusion(job, rules)
        if excluded:
            skipped.append({"ref": ref, "reason": exclusion_reason, "site": site_match.site})
            manual_review.append({"ref": ref, "reason": exclusion_reason})
            continue
        ppm_allowed, ppm_reason = ppm_tech_diary_review(job, rules)
        if not ppm_allowed:
            skipped.append({"ref": ref, "reason": ppm_reason, "site": site_match.site})
            manual_review.append({"ref": ref, "reason": ppm_reason})
            continue

        result = build_recommendation(client, job, rules)
        if isinstance(result, tuple):
            reason = result[1]
            if site_match.site == "Baltic Yard" and "No suitable active site-based resource" in reason:
                reason = "No suitable resource: Baltic Yard has no active matching Tech/CT resource"
            skipped.append({"ref": ref, "reason": reason, "site": site_match.site})
            if "No suitable" in reason or "review" in reason or "Baltic Yard" in reason:
                manual_review.append({"ref": ref, "reason": reason})
            continue

        record = {
            "job_ref": result.job_ref,
            "job_id": result.job_id,
            "site": result.site,
            "resource": result.proposed_resource,
            "resource_id": result.proposed_resource_id,
            "scheduled_date": result.proposed_date,
            "start": result.proposed_start,
            "end": result.proposed_end,
            "duration_minutes": result.duration_minutes,
            "confidence": result.confidence,
            "overlap_check": result.overlap_check,
        }
        mode = f"daily_allocate_{result.confidence.lower()}"
        ok, message = schedule_record(client, record, apply=apply, mode=mode)
        if ok:
            applied.append({**record, "mode": mode, "verification": message})
            audit_refs.add(ref)
            if result.confidence == "Low":
                manual_review.append({"ref": ref, "reason": LOW_REVIEW_NOTE})
        else:
            failed.append({"ref": ref, "error": message})

    return applied, skipped, failed, manual_review


def workload_warnings(client: BigChangeClient, rules: dict[str, Any], resources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    warnings: list[dict[str, Any]] = []
    start = dt.date.today()
    end = start + dt.timedelta(days=SEARCH_DAYS)
    for resource in active_btr_resources(resources, rules):
        resource_id = int(resource["id"])
        resource_name = str(resource.get("label") or "")
        diary = client.resource_diary(resource_id, start, end)
        counts: Counter[str] = Counter()
        for job in diary:
            if is_cancelled_diary_job(job):
                continue
            planned = parse_datetime(job.get("PlannedStart"))
            if not planned:
                continue
            counts[planned.date().isoformat()] += 1
        for day, count in sorted(counts.items()):
            if count >= 4:
                warnings.append({"resource": resource_name, "date": day, "jobs": count})
    return warnings


def write_summary(
    *,
    apply: bool,
    resources_count: int,
    active_count: int,
    phase1_applied: list[dict[str, Any]],
    phase1_skipped: list[dict[str, Any]],
    phase1_failed: list[dict[str, Any]],
    allocated: list[dict[str, Any]],
    allocation_skipped: list[dict[str, Any]],
    allocation_failed: list[dict[str, Any]],
    workload: list[dict[str, Any]],
    manual_review: list[dict[str, Any]],
) -> Path:
    today = dt.date.today().isoformat()
    path = SUMMARY_DIR / f"btr-daily-run-{today}.md"
    applied = phase1_applied + allocated
    skipped = phase1_skipped + allocation_skipped
    failed = phase1_failed + allocation_failed
    skipped_counts = Counter(item.get("reason", "Unknown") for item in skipped)
    manual_items = list(manual_review)
    manual_refs = {str(item.get("ref") or "") for item in manual_items}
    for item in skipped:
        reason = str(item.get("reason") or "")
        ref = str(item.get("ref") or "")
        if ref in manual_refs:
            continue
        if "manual review" in reason.lower():
            manual_items.append({"ref": ref, "reason": reason})
            manual_refs.add(ref)

    applied_rows = [
        [
            item.get("job_ref"),
            item.get("site"),
            item.get("resource"),
            item.get("scheduled_date"),
            f"{item.get('start')}-{item.get('end')}",
            item.get("confidence", ""),
            item.get("mode"),
        ]
        for item in applied
    ]
    skipped_rows = [[item.get("ref"), item.get("site", ""), item.get("reason")] for item in skipped]
    failed_rows = [[item.get("ref"), item.get("error")] for item in failed]
    workload_rows = [[item["resource"], item["date"], item["jobs"]] for item in workload]
    manual_rows = [[item.get("ref"), item.get("reason")] for item in manual_items]
    skipped_count_rows = [[reason, count] for reason, count in skipped_counts.most_common()]

    content = f"""# BTR Daily Run — {today}

**Run timestamp:** {utc_now()}  
**BigChange environment:** TEST  
**Mode:** {"APPLY" if apply else "DRY RUN"}  
**Resources connectivity check:** {resources_count} resources returned; {active_count} active JobWatch resources.

## Counts

| Category | Count |
|---|---:|
| Applied | {len(applied)} |
| Failed | {len(failed)} |
| Skipped | {len(skipped)} |

## Skipped by reason

{table(["Reason", "Count"], skipped_count_rows)}

## Applied jobs

{table(["Ref", "Site", "Resource", "Date", "Start-End", "Confidence", "Mode"], applied_rows)}

## Skipped jobs

{table(["Ref", "Site", "Reason"], skipped_rows)}

## Failed jobs

{table(["Ref", "Error"], failed_rows)}

## Workload warnings

{table(["Resource", "Date", "Planned jobs"], workload_rows)}

## Jobs needing manual review

{table(["Ref", "Reason"], manual_rows)}
"""
    path.write_text(content, encoding="utf-8")
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the daily BTR allocation workflow")
    parser.add_argument("--apply", action="store_true", help="Write schedules to BigChange and append audit records")
    args = parser.parse_args()

    rules = load_rules()
    client = BigChangeClient()
    resources = client.resources()
    active_count = sum(1 for resource in resources if resource_is_active_for_jobwatch(resource))
    audit_refs = load_audit_refs()

    phase1_applied, phase1_skipped, phase1_failed = process_stale_diary(
        client, rules, resources, audit_refs, apply=args.apply
    )
    allocated, allocation_skipped, allocation_failed, manual_review = process_unallocated(
        client, rules, audit_refs, apply=args.apply
    )
    workload = workload_warnings(client, rules, resources)
    summary_path = write_summary(
        apply=args.apply,
        resources_count=len(resources),
        active_count=active_count,
        phase1_applied=phase1_applied,
        phase1_skipped=phase1_skipped,
        phase1_failed=phase1_failed,
        allocated=allocated,
        allocation_skipped=allocation_skipped,
        allocation_failed=allocation_failed,
        workload=workload,
        manual_review=manual_review,
    )
    summary = {
        "summary_path": str(summary_path.relative_to(ROOT)),
        "mode": "apply" if args.apply else "dry-run",
        "applied": len(phase1_applied) + len(allocated),
        "failed": len(phase1_failed) + len(allocation_failed),
        "skipped": len(phase1_skipped) + len(allocation_skipped),
    }
    print(json.dumps(summary, indent=2))
    return 0 if summary["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
