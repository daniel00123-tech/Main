#!/usr/bin/env python3
"""Daily BigChange BTR allocation runner.

Discovers current unallocated BTR jobs and stale non-PPM diary jobs, applies
safe allocations in the TEST environment, and writes a daily audit summary.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from bigchange_btr_allocation import (  # noqa: E402
    BigChangeClient,
    CLOSED_STATUS_IDS,
    Recommendation,
    adjacent_bookings,
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
SEARCH_DAYS = 14


def as_int(value: Any, default: int | None = None) -> int | None:
    if value in (None, ""):
        return default
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


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


def is_open_diary_job(job: dict[str, Any]) -> bool:
    if is_cancelled_diary_job(job):
        return False
    status = normalise(job.get("Status"))
    if status in {"complete", "completed", "cancelled", "deleted", "rejected"}:
        return False
    status_id = as_int(job.get("StatusId"))
    return status_id not in CLOSED_STATUS_IDS


def job_identity(job: dict[str, Any]) -> tuple[int | None, str]:
    return as_int(job.get("JobId")), str(job.get("Ref") or "").strip()


def same_job(job: dict[str, Any], job_id: int | None, job_ref: str) -> bool:
    row_id, row_ref = job_identity(job)
    return (job_id is not None and row_id == job_id) or (job_ref and row_ref == job_ref)


def planned_end_for(start: dt.datetime, duration_minutes: int) -> dt.datetime:
    return start + dt.timedelta(minutes=duration_minutes)


def verify_scheduled(
    client: BigChangeClient,
    *,
    job_id: int | None,
    job_ref: str,
    resource_id: int,
    start_at: dt.datetime,
    duration_minutes: int,
) -> tuple[bool, str]:
    diary = client.resource_diary(resource_id, start_at.date(), start_at.date())
    end_at = planned_end_for(start_at, duration_minutes)
    found = False
    for row in diary:
        if not same_job(row, job_id, job_ref):
            continue
        planned = parse_datetime(row.get("PlannedStart"))
        if planned == start_at and not is_cancelled_diary_job(row):
            found = True
            break
    if not found:
        return False, "scheduled job was not found on intended resource diary after JobSchedule"

    other_blocks = []
    for row in diary:
        if same_job(row, job_id, job_ref) or is_cancelled_diary_job(row):
            continue
        block_start = parse_datetime(row.get("PlannedStart"))
        if not block_start or block_start.date() != start_at.date():
            continue
        block_end = parse_datetime(row.get("PlannedEnd"))
        if not block_end:
            duration = parse_duration(row.get("Duration")) or 60
            block_end = block_start + dt.timedelta(minutes=duration)
        if block_end and block_end > block_start:
            other_blocks.append((block_start, block_end, str(row.get("Ref") or "")))
    if any(start_at < block_end and end_at > block_start for block_start, block_end, _ in other_blocks):
        return False, "scheduled job overlaps another non-cancelled diary booking after JobSchedule"
    return True, "verified on intended resource diary with no overlaps"


def find_resource_slot(
    client: BigChangeClient,
    resource_id: int,
    duration_minutes: int,
    rules: dict[str, Any],
    *,
    search_days: int = SEARCH_DAYS,
) -> tuple[dt.date, dt.time, dt.time, str, str] | None:
    today = dt.date.today()
    start_day = today
    while start_day.weekday() >= 5:
        start_day += dt.timedelta(days=1)
    end_day = start_day + dt.timedelta(days=search_days)
    diary = client.resource_diary(resource_id, start_day, end_day)
    schedule_jobs = [job for job in diary if not is_cancelled_diary_job(job)]
    working_hours_cache: dict[int, list[dict[str, Any]]] = {}

    for offset in range(search_days + 1):
        day = start_day + dt.timedelta(days=offset)
        if day.weekday() >= 5:
            continue
        windows = resource_working_windows(client, resource_id, day, working_hours_cache, rules)
        if not windows:
            continue
        blocks = diary_blocks(schedule_jobs, day)
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


def resource_lookup(resources: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    lookup: dict[int, dict[str, Any]] = {}
    for resource in resources:
        resource_id = as_int(resource.get("id"))
        if resource_id is not None:
            lookup[resource_id] = resource
    return lookup


def btr_resources(resources: list[dict[str, Any]], rules: dict[str, Any]) -> list[dict[str, Any]]:
    result = []
    for resource in resources:
        name = str(resource.get("label") or "")
        if resource_site(name, rules) and resource_role(name, rules):
            result.append(resource)
    return result


def discover_stale_diary_jobs(
    client: BigChangeClient,
    resources: list[dict[str, Any]],
    rules: dict[str, Any],
    *,
    lookback_days: int,
) -> list[dict[str, Any]]:
    today = dt.date.today()
    start = today - dt.timedelta(days=lookback_days)
    end = today - dt.timedelta(days=1)
    if end < start:
        return []

    seen: set[tuple[int | None, str]] = set()
    candidates: list[dict[str, Any]] = []
    for resource in btr_resources(resources, rules):
        resource_id = as_int(resource.get("id"))
        if resource_id is None:
            continue
        resource_name = str(resource.get("label") or "")
        try:
            diary = client.resource_diary(resource_id, start, end)
        except Exception as exc:
            candidates.append(
                {
                    "discovery_error": str(exc),
                    "resource": resource_name,
                    "resource_id": resource_id,
                }
            )
            continue
        for job in diary:
            planned_start = parse_datetime(job.get("PlannedStart"))
            if not planned_start or planned_start.date() >= today:
                continue
            if not is_open_diary_job(job):
                continue
            ident = job_identity(job)
            if ident in seen:
                continue
            seen.add(ident)
            enriched = dict(job)
            enriched["_resource_id"] = resource_id
            enriched["_resource_name"] = resource_name
            enriched["_resource_site"] = resource_site(resource_name, rules)
            enriched["_resource_role"] = resource_role(resource_name, rules)
            candidates.append(enriched)
    candidates.sort(key=lambda job: (str(job.get("PlannedStart") or ""), str(job.get("Ref") or "")))
    return candidates


def choose_slot_for_stale_job(
    client: BigChangeClient,
    job: dict[str, Any],
    resources_by_id: dict[int, dict[str, Any]],
    rules: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    ref = str(job.get("Ref") or "")
    site = job.get("_resource_site") or (identify_site(job, rules).site if identify_site(job, rules) else None)
    if not site:
        raise RuntimeError("BTR site could not be identified from assigned resource or job metadata")

    if is_ppm_job(job):
        raise RuntimeError("manual review only: stale PPM diary entry must not be auto-rescheduled")

    resource_id = as_int(job.get("_resource_id"))
    resource_name = str(job.get("_resource_name") or job.get("Resource") or "")
    if resource_id is None:
        raise RuntimeError("assigned resource id is missing")
    resource = resources_by_id.get(resource_id, {})
    role = job.get("_resource_role") or resource_role(resource_name, rules) or determine_role(job).role
    if not role:
        raise RuntimeError("assigned resource role could not be identified")

    duration, duration_reason, duration_confidence = estimate_duration(job, rules)
    original_resource_usable = (
        bool(resource)
        and resource_is_active_for_jobwatch(resource)
        and not resource_is_excluded(resource_name, rules)
    )

    if original_resource_usable:
        slot = find_resource_slot(client, resource_id, duration, rules)
        if not slot:
            raise RuntimeError("no suitable slot found on existing assigned resource within search window")
        date, start, end, before, after = slot
        confidence = "High" if duration_confidence == "High" else duration_confidence
        return (
            {
                "job_ref": ref,
                "job_id": as_int(job.get("JobId")),
                "site": site,
                "resource": resource_name,
                "resource_id": resource_id,
                "scheduled_date": date.isoformat(),
                "start": start.strftime("%H:%M"),
                "end": end.strftime("%H:%M"),
                "duration_minutes": duration,
                "confidence": confidence,
                "mode": "daily_incomplete_reschedule",
                "original_date": str(job.get("PlannedStart") or "")[:10],
                "overlap_check": "Passed",
                "duration_reason": duration_reason,
                "booking_before": before,
                "booking_after": after,
            },
            {"note": "kept same active assigned resource"},
        )

    replacement_role = "HK" if role == "HK" else "Tech"
    from bigchange_btr_allocation import choose_resource  # local import avoids exporting this helper here

    replacement, slot, warnings = choose_resource(client, site, replacement_role, duration, rules)
    if not replacement or not slot:
        raise RuntimeError(
            "assigned resource inactive/excluded and no replacement found: " + "; ".join(warnings)
        )
    return (
        {
            "job_ref": ref,
            "job_id": as_int(job.get("JobId")),
            "site": site,
            "resource": replacement.name,
            "resource_id": replacement.resource_id,
            "scheduled_date": slot.date.isoformat(),
            "start": slot.start.strftime("%H:%M"),
            "end": slot.end.strftime("%H:%M"),
            "duration_minutes": slot.duration_minutes,
            "confidence": "Medium",
            "mode": "daily_incomplete_reschedule",
            "original_date": str(job.get("PlannedStart") or "")[:10],
            "overlap_check": "Passed",
            "duration_reason": duration_reason,
            "booking_before": slot.booking_before,
            "booking_after": slot.booking_after,
        },
        {"note": f"reassigned because original resource was inactive or excluded: {resource_name}"},
    )


def schedule_and_verify(
    client: BigChangeClient,
    record: dict[str, Any],
    *,
    dry_run: bool,
) -> dict[str, Any]:
    scheduled_at = dt.datetime.strptime(
        f"{record['scheduled_date']} {record['start']}:00",
        "%Y-%m-%d %H:%M:%S",
    )
    job_id = as_int(record.get("job_id"))
    job_ref = str(record.get("job_ref") or "")
    resource_id = int(record["resource_id"])
    duration = int(record["duration_minutes"])

    if dry_run:
        return {**record, "dry_run": True}

    client.schedule_job(job_id or 0, resource_id, scheduled_at.strftime("%Y-%m-%d %H:%M:%S"), duration)
    verified, message = verify_scheduled(
        client,
        job_id=job_id,
        job_ref=job_ref,
        resource_id=resource_id,
        start_at=scheduled_at,
        duration_minutes=duration,
    )
    if not verified:
        client.schedule_job(job_id or 0, resource_id, scheduled_at.strftime("%Y-%m-%d %H:%M:%S"), duration)
        verified, message = verify_scheduled(
            client,
            job_id=job_id,
            job_ref=job_ref,
            resource_id=resource_id,
            start_at=scheduled_at,
            duration_minutes=duration,
        )
    if not verified:
        raise RuntimeError(message)

    audit_record = {
        **record,
        "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
        "verification": message,
    }
    append_audit(audit_record)
    return audit_record


def apply_recommendation(
    client: BigChangeClient,
    recommendation: Recommendation,
    *,
    mode: str,
    dry_run: bool,
) -> dict[str, Any]:
    record = {
        "job_ref": recommendation.job_ref,
        "job_id": recommendation.job_id,
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
        "booking_before": recommendation.booking_before,
        "booking_after": recommendation.booking_after,
    }
    return schedule_and_verify(client, record, dry_run=dry_run)


def skip_reason_counts(skipped: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = collections.Counter()
    for item in skipped:
        counts[str(item.get("reason") or "unknown")] += 1
    return dict(sorted(counts.items()))


def workload_warnings(client: BigChangeClient, applied: list[dict[str, Any]]) -> list[str]:
    keys = {
        (as_int(record.get("resource_id")), str(record.get("scheduled_date") or ""), str(record.get("resource") or ""))
        for record in applied
        if record.get("resource_id") and record.get("scheduled_date")
    }
    warnings: list[str] = []
    for resource_id, date_text, resource_name in sorted(keys, key=lambda item: (item[1], item[2])):
        if resource_id is None:
            continue
        day = dt.date.fromisoformat(date_text)
        diary = client.resource_diary(resource_id, day, day)
        planned = [
            job
            for job in diary
            if parse_datetime(job.get("PlannedStart"))
            and parse_datetime(job.get("PlannedStart")).date() == day
            and not is_cancelled_diary_job(job)
        ]
        if len(planned) >= 4:
            refs = ", ".join(str(job.get("Ref") or "") for job in planned[:8])
            warnings.append(f"{resource_name} has {len(planned)} non-cancelled planned jobs on {date_text}: {refs}")
    return warnings


def markdown_table(headers: list[str], rows: list[list[Any]]) -> str:
    if not rows:
        return "_None_"
    lines = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    for row in rows:
        lines.append("| " + " | ".join(str(value).replace("\n", " ") for value in row) + " |")
    return "\n".join(lines)


def write_summary(
    *,
    run_timestamp: str,
    resources_count: int,
    active_resources_count: int,
    stale_candidates_count: int,
    unallocated_btr_count: int,
    applied: list[dict[str, Any]],
    skipped: list[dict[str, Any]],
    failed: list[dict[str, Any]],
    warnings: list[str],
    dry_run: bool,
) -> Path:
    today = dt.date.today().isoformat()
    path = SUMMARY_DIR / f"btr-daily-run-{today}.md"
    low_confidence = [record for record in applied if record.get("confidence") == "Low"]
    manual_review = [
        item
        for item in skipped
        if any(
            token in normalise(item.get("reason"))
            for token in ("manual", "ppm", "contractor", "aquilo", "baltic", "no suitable resource")
        )
    ] + [
        {
            "ref": record.get("job_ref"),
            "site": record.get("site"),
            "reason": "low confidence allocation - human review recommended",
        }
        for record in low_confidence
    ]

    content = f"""# BTR Daily Run - {today}

**Run timestamp:** {run_timestamp}  
**Mode:** {"dry run (no BigChange writes)" if dry_run else "applied to BigChange TEST"}  
**API connectivity:** Resources call succeeded ({resources_count} resources, {active_resources_count} active for JobWatch)

## Counts

| Category | Count |
|---|---:|
| Applied | {len(applied)} |
| Failed | {len(failed)} |
| Skipped | {len(skipped)} |
| Stale diary candidates reviewed | {stale_candidates_count} |
| Unallocated BTR jobs reviewed | {unallocated_btr_count} |

## Skipped by reason

{markdown_table(["Reason", "Count"], [[reason, count] for reason, count in skip_reason_counts(skipped).items()])}

## Applied jobs

{markdown_table(
    ["Ref", "Site", "Resource", "Date", "Start-End", "Confidence", "Mode"],
    [
        [
            record.get("job_ref"),
            record.get("site"),
            record.get("resource"),
            record.get("scheduled_date"),
            f"{record.get('start')}-{record.get('end')}",
            record.get("confidence"),
            record.get("mode"),
        ]
        for record in applied
    ],
)}

## Skipped jobs

{markdown_table(
    ["Ref", "Site", "Reason"],
    [[item.get("ref"), item.get("site", ""), item.get("reason")] for item in skipped],
)}

## Failed jobs

{markdown_table(
    ["Ref", "Site", "Error"],
    [[item.get("ref"), item.get("site", ""), item.get("error")] for item in failed],
)}

## Workload warnings

{chr(10).join(f"- {item}" for item in warnings) if warnings else "_None_"}

## Manual review

{markdown_table(
    ["Ref", "Site", "Reason"],
    [[item.get("ref"), item.get("site", ""), item.get("reason")] for item in manual_review],
)}
"""
    path.write_text(content, encoding="utf-8")
    return path


def run(*, lookback_days: int, dry_run: bool) -> int:
    run_timestamp = dt.datetime.now(dt.timezone.utc).isoformat()
    rules = load_rules()
    audited_refs = load_audited_refs()
    client = BigChangeClient()
    resources = client.resources()
    resources_by_id = resource_lookup(resources)
    active_resources_count = sum(1 for resource in resources if resource_is_active_for_jobwatch(resource))

    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []

    stale_candidates = discover_stale_diary_jobs(client, resources, rules, lookback_days=lookback_days)
    for job in stale_candidates:
        if job.get("discovery_error"):
            failed.append(
                {
                    "ref": f"resource:{job.get('resource_id')}",
                    "site": "",
                    "error": f"failed to fetch resource diary for {job.get('resource')}: {job.get('discovery_error')}",
                }
            )
            continue
        ref = str(job.get("Ref") or "")
        site = str(job.get("_resource_site") or "")
        if ref in audited_refs:
            skipped.append({"ref": ref, "site": site, "reason": "already present in allocation audit log"})
            continue
        excluded, exclusion_reason = contractor_exclusion(job, rules)
        if excluded:
            skipped.append({"ref": ref, "site": site, "reason": exclusion_reason})
            continue
        if is_ppm_job(job):
            skipped.append({"ref": ref, "site": site, "reason": "manual review only: stale PPM diary entry"})
            continue
        try:
            record, extra = choose_slot_for_stale_job(client, job, resources_by_id, rules)
            if extra.get("note"):
                record["note"] = extra["note"]
            applied_record = schedule_and_verify(client, record, dry_run=dry_run)
            applied.append(applied_record)
            audited_refs.add(ref)
            print(f"Rescheduled stale job: {ref} -> {record['resource']} {record['scheduled_date']} {record['start']}-{record['end']}")
        except Exception as exc:
            failed.append({"ref": ref, "site": site, "error": str(exc)})
            print(f"Failed stale reschedule: {ref}: {exc}", file=sys.stderr)

    unallocated_jobs = fetch_unallocated_jobs(client, lookback_days=lookback_days)
    unallocated_btr_count = 0
    for job in sorted(unallocated_jobs, key=lambda item: str(item.get("Ref") or "")):
        ref = str(job.get("Ref") or "")
        site_match = identify_site(job, rules)
        excluded, exclusion_reason = contractor_exclusion(job, rules)
        if not site_match and not excluded:
            continue
        site = site_match.site if site_match else ""
        unallocated_btr_count += 1
        if excluded:
            skipped.append({"ref": ref, "site": site, "reason": exclusion_reason})
            continue
        ppm_allowed, ppm_reason = ppm_tech_diary_review(job, rules)
        if not ppm_allowed:
            skipped.append({"ref": ref, "site": site, "reason": ppm_reason})
            continue
        try:
            result = build_recommendation(client, job, rules)
            if isinstance(result, tuple):
                skipped.append({"ref": ref, "site": site, "reason": result[1]})
                continue
            mode = f"daily_allocate_{result.confidence.lower()}"
            applied_record = apply_recommendation(client, result, mode=mode, dry_run=dry_run)
            applied.append(applied_record)
            audited_refs.add(ref)
            print(
                f"Allocated unallocated job: {ref} -> {result.proposed_resource} "
                f"{result.proposed_date} {result.proposed_start}-{result.proposed_end} ({result.confidence})"
            )
        except Exception as exc:
            failed.append({"ref": ref, "site": site, "error": str(exc)})
            print(f"Failed unallocated allocation: {ref}: {exc}", file=sys.stderr)

    warnings = [] if dry_run else workload_warnings(client, applied)
    summary_path = write_summary(
        run_timestamp=run_timestamp,
        resources_count=len(resources),
        active_resources_count=active_resources_count,
        stale_candidates_count=len(stale_candidates),
        unallocated_btr_count=unallocated_btr_count,
        applied=applied,
        skipped=skipped,
        failed=failed,
        warnings=warnings,
        dry_run=dry_run,
    )
    print(
        json.dumps(
            {
                "summary": str(summary_path),
                "applied": len(applied),
                "skipped": len(skipped),
                "failed": len(failed),
                "dry_run": dry_run,
            },
            indent=2,
        )
    )
    return 0 if not failed else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Run daily BTR allocation workflow")
    parser.add_argument("--lookback-days", type=int, default=LOOKBACK_DAYS)
    parser.add_argument("--dry-run", action="store_true", help="Review and write summary without BigChange writes or audit appends")
    args = parser.parse_args()
    return run(lookback_days=args.lookback_days, dry_run=args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
