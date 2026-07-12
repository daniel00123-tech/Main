#!/usr/bin/env python3
"""Daily BigChange BTR allocation run for unallocated and stale-diary jobs."""

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
    CLOSED_STATUS_IDS,
    BigChangeClient,
    Recommendation,
    adjacent_bookings,
    as_int,
    build_recommendation,
    contractor_exclusion,
    determine_role,
    diary_blocks,
    estimate_duration,
    fetch_unallocated_jobs,
    identify_site,
    is_cancelled_diary_job,
    is_ppm_job,
    is_unallocated,
    load_rules,
    next_working_day,
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
    find_slot,
)


AUDIT_PATH = ROOT / "automation-memory/btr-allocation-audit.jsonl"
SUMMARY_DIR = ROOT / "automation-memory"
LOOKBACK_DAYS = 14
SEARCH_DAYS = 14


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


def fetch_job(client: BigChangeClient, job_id: int) -> dict[str, Any] | None:
    payload = client.get("Job", {"JobId": job_id})
    if payload.get("Code") not in (0, None):
        return None
    result = payload.get("Result")
    if isinstance(result, list) and result:
        return result[0] if isinstance(result[0], dict) else None
    return result if isinstance(result, dict) else None


def schedule_datetime(date_text: str, start_text: str) -> str:
    return f"{date_text} {start_text}:00"


def audit_record(
    recommendation: Recommendation,
    job_id: int,
    *,
    mode: str,
    original_date: str | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    record: dict[str, Any] = {
        "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
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
    }
    if original_date:
        record["original_date"] = original_date
    if note:
        record["note"] = note
    return record


def active_site_resources(resources: list[dict[str, Any]], rules: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        resource
        for resource in resources
        if resource_is_active_for_jobwatch(resource)
        and resource_site(str(resource.get("label") or ""), rules)
        and resource_role(str(resource.get("label") or ""), rules)
        and not resource_is_excluded(str(resource.get("label") or ""), rules)
    ]


def btr_diary_resources(resources: list[dict[str, Any]], rules: dict[str, Any]) -> list[dict[str, Any]]:
    """Resources whose names identify a BTR site/role; inactive resources are scanned for stale jobs."""
    return [
        resource
        for resource in resources
        if resource_site(str(resource.get("label") or ""), rules)
        and resource_role(str(resource.get("label") or ""), rules)
        and not resource_is_excluded(str(resource.get("label") or ""), rules)
    ]


def stale_ppm_manual_reason(job: dict[str, Any], rules: dict[str, Any]) -> str | None:
    if is_ppm_job(job):
        return "stale PPM diary entry requires manual review only"

    text = normalise(f"{job.get('Ref')} {job.get('Type')} {job.get('Description')}")
    ppm_rules = rules.get("ppm_review", {})
    heavy_terms = [term for term in ppm_rules.get("heavy_specialist_terms", []) if term in text]
    frequency_terms = ppm_rules.get("frequency_terms", ["weekly", "monthly", "daily", "6 monthly"])
    if heavy_terms and any(term in text for term in frequency_terms):
        return f"stale specialist/PPM-style diary entry requires manual review ({', '.join(sorted(set(heavy_terms)))})"
    return None


def open_stale_diary_job(job: dict[str, Any], today: dt.date) -> bool:
    if is_cancelled_diary_job(job):
        return False
    if as_int(job.get("StatusId")) in CLOSED_STATUS_IDS:
        return False
    planned = parse_datetime(job.get("PlannedStart"))
    return bool(planned and planned.date() < today)


def find_resource_slot(
    client: BigChangeClient,
    rules: dict[str, Any],
    resource_id: int,
    duration_minutes: int,
    *,
    start_day: dt.date,
    search_days: int = SEARCH_DAYS,
) -> tuple[Any | None, str]:
    working_hours_cache: dict[int, list[dict[str, Any]]] = {}
    end_day = start_day + dt.timedelta(days=search_days)
    diary = client.resource_diary(resource_id, start_day, end_day)
    schedule_jobs = [entry for entry in diary if not is_cancelled_diary_job(entry)]
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
        slot.booking_before, slot.booking_after = adjacent_bookings(blocks, slot_start, slot_end)
        return slot, "slot found"
    return None, "no suitable diary slot found within search window"


def recommendation_for_existing_resource(
    client: BigChangeClient,
    job: dict[str, Any],
    rules: dict[str, Any],
    resource: dict[str, Any],
    site: str,
    *,
    start_day: dt.date,
) -> Recommendation | tuple[str, str]:
    resource_name = str(resource.get("label") or job.get("Resource") or "")
    role_match = determine_role(job)
    if not role_match.role:
        role = resource_role(resource_name, rules) or ""
        if not role:
            return str(job.get("Ref") or ""), "could not determine role for stale diary job"
        role_match.role = role
        role_match.reason = "Kept existing assigned resource role for stale diary reschedule"
        role_match.confidence = "Medium"

    duration, duration_reason, duration_confidence = estimate_duration(job, rules)
    resource_id = int(resource["id"])
    slot, slot_reason = find_resource_slot(client, rules, resource_id, duration, start_day=start_day)
    if not slot:
        return str(job.get("Ref") or ""), slot_reason

    confidence_parts = ["High", role_match.confidence, duration_confidence]
    if "Low" in confidence_parts:
        confidence = "Low"
    elif "Medium" in confidence_parts:
        confidence = "Medium"
    else:
        confidence = "High"

    return Recommendation(
        job_ref=str(job.get("Ref") or ""),
        job_id=int(job.get("JobId") or 0),
        site=site,
        site_identification=f"Trusted assigned resource site from '{resource_name}'",
        description=str(job.get("Description") or "")[:500],
        status=str(job.get("Status") or ""),
        flags=str(job.get("CurrentFlag") or "None"),
        required_role=role_match.role,
        proposed_resource=resource_name,
        proposed_resource_id=resource_id,
        proposed_date=slot.date.isoformat(),
        proposed_start=slot.start.strftime("%H:%M"),
        proposed_end=slot.end.strftime("%H:%M"),
        duration_minutes=slot.duration_minutes,
        duration_reason=duration_reason,
        resource_reason="Kept existing active resource for incomplete non-PPM diary reschedule",
        contractor_check="Passed",
        ppm_check="Not a PPM job",
        overlap_check="Passed",
        booking_before=slot.booking_before,
        booking_after=slot.booking_after,
        priority=str(job.get("CurrentFlag") or job.get("Status") or "Routine"),
        target_date=str(job.get("DueDate") or "Not specified"),
        confidence=confidence,
        assumptions=[],
    )


def apply_and_verify(
    client: BigChangeClient,
    recommendation: Recommendation,
    job_id: int,
    *,
    apply: bool,
) -> tuple[bool, str]:
    if not apply:
        return True, "dry run"

    schedule_dt = schedule_datetime(recommendation.proposed_date, recommendation.proposed_start)
    client.schedule_job(job_id, recommendation.proposed_resource_id, schedule_dt, recommendation.duration_minutes)

    verified, reason = verify_schedule(client, recommendation, job_id)
    if verified:
        return True, "verified"
    if "resource missing" in reason:
        client.schedule_job(job_id, recommendation.proposed_resource_id, schedule_dt, recommendation.duration_minutes)
        verified, reason = verify_schedule(client, recommendation, job_id)
        if verified:
            return True, "verified after resource-drop reapply"
    return False, reason


def verify_schedule(client: BigChangeClient, recommendation: Recommendation, job_id: int) -> tuple[bool, str]:
    job = fetch_job(client, job_id)
    if not job:
        return False, "verification failed: job not found after scheduling"

    planned = parse_datetime(job.get("PlannedStart"))
    if not planned:
        return False, "verification failed: planned start missing after scheduling"

    resource_text = normalise(job.get("Resource"))
    if not resource_text:
        return False, "verification failed: resource missing after scheduling"

    expected_day = dt.date.fromisoformat(recommendation.proposed_date)
    diary = client.resource_diary(recommendation.proposed_resource_id, expected_day, expected_day)
    matching = [entry for entry in diary if int(entry.get("JobId") or 0) == job_id or str(entry.get("Ref") or "") == recommendation.job_ref]
    if not matching:
        return False, "verification failed: job not present on intended resource diary"

    slot_start = dt.datetime.combine(expected_day, dt.datetime.strptime(recommendation.proposed_start, "%H:%M").time())
    slot_end = slot_start + dt.timedelta(minutes=recommendation.duration_minutes)
    for entry in diary:
        if is_cancelled_diary_job(entry):
            continue
        if int(entry.get("JobId") or 0) == job_id:
            continue
        other_start = parse_datetime(entry.get("PlannedStart"))
        if not other_start or other_start.date() != expected_day:
            continue
        other_end = parse_datetime(entry.get("PlannedEnd"))
        if not other_end:
            duration = parse_duration(entry.get("Duration")) or 60
            other_end = other_start + dt.timedelta(minutes=duration)
        if slot_start < other_end and slot_end > other_start:
            return False, f"verification failed: overlaps {entry.get('Ref')} {other_start:%H:%M}-{other_end:%H:%M}"
    return True, "verified"


def run_stale_reschedules(
    client: BigChangeClient,
    rules: dict[str, Any],
    resources: list[dict[str, Any]],
    audited_refs: set[str],
    *,
    apply: bool,
    today: dt.date,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    manual: list[dict[str, Any]] = []
    seen_job_ids: set[int] = set()

    start = today - dt.timedelta(days=LOOKBACK_DAYS)
    end = today - dt.timedelta(days=1)
    if end < start:
        return applied, skipped, failed, manual

    resources_by_id = {int(resource["id"]): resource for resource in resources if resource.get("id") is not None}
    for resource in btr_diary_resources(resources, rules):
        resource_id = int(resource["id"])
        resource_name = str(resource.get("label") or "")
        site = resource_site(resource_name, rules)
        if not site:
            continue
        try:
            diary = client.resource_diary(resource_id, start, end)
        except Exception as exc:  # keep the batch moving on one resource failure
            failed.append({"ref": resource_name, "error": f"failed to fetch stale diary: {exc}", "mode": "daily_incomplete_reschedule"})
            continue

        for job in diary:
            job_id = int(job.get("JobId") or 0)
            ref = str(job.get("Ref") or "")
            if not job_id or job_id in seen_job_ids:
                continue
            seen_job_ids.add(job_id)
            if not open_stale_diary_job(job, today):
                continue

            original_planned = str(job.get("PlannedStart") or "")
            if ref in audited_refs:
                skipped.append({"ref": ref, "reason": "already present in allocation audit", "mode": "daily_incomplete_reschedule"})
                continue

            excluded, exclusion_reason = contractor_exclusion(job, rules)
            if excluded:
                skipped.append({"ref": ref, "reason": exclusion_reason, "mode": "daily_incomplete_reschedule"})
                manual.append({"ref": ref, "reason": exclusion_reason})
                continue

            ppm_reason = stale_ppm_manual_reason(job, rules)
            if ppm_reason:
                skipped.append({"ref": ref, "reason": ppm_reason, "mode": "daily_incomplete_reschedule"})
                manual.append({"ref": ref, "reason": ppm_reason})
                continue

            if resource_is_active_for_jobwatch(resource):
                recommendation = recommendation_for_existing_resource(
                    client,
                    job,
                    rules,
                    resource,
                    site,
                    start_day=next_working_day(today),
                )
                note = "kept existing assigned resource"
            else:
                role = determine_role(job).role or resource_role(resource_name, rules) or "Tech"
                recommendation = build_recommendation(client, job, rules)
                note = f"original resource inactive; attempted reassignment as {role}"

            if isinstance(recommendation, tuple):
                skipped.append({"ref": ref, "reason": recommendation[1], "mode": "daily_incomplete_reschedule"})
                continue

            ok, verify_reason = apply_and_verify(client, recommendation, job_id, apply=apply)
            if not ok:
                failed.append({"ref": ref, "error": verify_reason, "mode": "daily_incomplete_reschedule"})
                continue

            record = audit_record(
                recommendation,
                job_id,
                mode="daily_incomplete_reschedule",
                original_date=original_planned,
                note=note if verify_reason == "verified" else f"{note}; {verify_reason}",
            )
            if apply:
                append_audit(record)
                audited_refs.add(ref)
            applied.append(record)

    return applied, skipped, failed, manual


def run_unallocated_allocations(
    client: BigChangeClient,
    rules: dict[str, Any],
    audited_refs: set[str],
    *,
    apply: bool,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    manual: list[dict[str, Any]] = []

    jobs = fetch_unallocated_jobs(client, lookback_days=LOOKBACK_DAYS)
    for job in sorted(jobs, key=lambda item: str(item.get("Ref") or "")):
        ref = str(job.get("Ref") or "")
        site_match = identify_site(job, rules)
        if not site_match:
            continue

        if ref in audited_refs and not is_unallocated(job):
            skipped.append({"ref": ref, "reason": "already present in allocation audit", "mode": "daily_allocate"})
            continue

        excluded, exclusion_reason = contractor_exclusion(job, rules)
        if excluded:
            skipped.append({"ref": ref, "reason": exclusion_reason, "mode": "daily_allocate"})
            manual.append({"ref": ref, "reason": exclusion_reason})
            continue

        ppm_allowed, ppm_reason = ppm_tech_diary_review(job, rules)
        if not ppm_allowed:
            skipped.append({"ref": ref, "reason": ppm_reason, "mode": "daily_allocate"})
            manual.append({"ref": ref, "reason": ppm_reason})
            continue

        recommendation = build_recommendation(client, job, rules)
        if isinstance(recommendation, tuple):
            reason = recommendation[1]
            skipped.append({"ref": ref, "reason": reason, "mode": "daily_allocate"})
            if "contractor" in normalise(reason) or "ppm" in normalise(reason) or "no suitable" in normalise(reason) or "baltic" in normalise(reason):
                manual.append({"ref": ref, "reason": reason})
            continue

        mode = f"daily_allocate_{recommendation.confidence.lower()}"
        ok, verify_reason = apply_and_verify(client, recommendation, int(job["JobId"]), apply=apply)
        if not ok:
            failed.append({"ref": ref, "error": verify_reason, "mode": mode})
            continue

        note = None if verify_reason == "verified" else verify_reason
        record = audit_record(recommendation, int(job["JobId"]), mode=mode, note=note)
        if apply:
            append_audit(record)
            audited_refs.add(ref)
        applied.append(record)
        if recommendation.confidence == "Low":
            manual.append({"ref": ref, "reason": "low-confidence allocation applied; human review recommended"})

    return applied, skipped, failed, manual


def workload_warnings(
    client: BigChangeClient,
    rules: dict[str, Any],
    resources: list[dict[str, Any]],
    *,
    today: dt.date,
) -> list[dict[str, Any]]:
    warnings: list[dict[str, Any]] = []
    start = today
    end = today + dt.timedelta(days=SEARCH_DAYS)
    for resource in active_site_resources(resources, rules):
        resource_id = int(resource["id"])
        resource_name = str(resource.get("label") or "")
        try:
            diary = client.resource_diary(resource_id, start, end)
        except Exception:
            continue
        counts: Counter[dt.date] = Counter()
        refs_by_day: dict[dt.date, list[str]] = defaultdict(list)
        for job in diary:
            if is_cancelled_diary_job(job):
                continue
            planned = parse_datetime(job.get("PlannedStart"))
            if not planned:
                continue
            counts[planned.date()] += 1
            refs_by_day[planned.date()].append(str(job.get("Ref") or ""))
        for day, count in sorted(counts.items()):
            if count >= 4:
                warnings.append(
                    {
                        "resource": resource_name,
                        "date": day.isoformat(),
                        "job_count": count,
                        "refs": ", ".join(ref for ref in refs_by_day[day] if ref),
                    }
                )
    return warnings


def markdown_table(headers: list[str], rows: list[list[Any]]) -> str:
    if not rows:
        return "_None._"
    lines = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    for row in rows:
        lines.append("| " + " | ".join(str(item).replace("\n", " ") for item in row) + " |")
    return "\n".join(lines)


def write_summary(
    *,
    today: dt.date,
    started_at: str,
    apply: bool,
    applied: list[dict[str, Any]],
    skipped: list[dict[str, Any]],
    failed: list[dict[str, Any]],
    manual: list[dict[str, Any]],
    warnings: list[dict[str, Any]],
) -> Path:
    skipped_counts = Counter(item["reason"] for item in skipped)
    path = SUMMARY_DIR / f"btr-daily-run-{today.isoformat()}.md"
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
    skipped_rows = [[item.get("ref"), item.get("reason"), item.get("mode", "")] for item in skipped]
    failed_rows = [[item.get("ref"), item.get("error"), item.get("mode", "")] for item in failed]
    warning_rows = [[item["resource"], item["date"], item["job_count"], item["refs"]] for item in warnings]
    manual_rows = [[item.get("ref"), item.get("reason")] for item in manual]
    skipped_count_rows = [[reason, count] for reason, count in skipped_counts.most_common()]

    content = f"""# BTR Daily Allocation Run — {today.isoformat()}

**Run timestamp:** {started_at}  
**Mode:** {"apply" if apply else "dry-run"}  
**Lookback window:** {LOOKBACK_DAYS} days

## Counts

| Applied | Failed | Skipped |
|---:|---:|---:|
| {len(applied)} | {len(failed)} | {len(skipped)} |

### Skipped by reason

{markdown_table(["Reason", "Count"], skipped_count_rows)}

## Applied jobs

{markdown_table(["Ref", "Site", "Resource", "Date", "Start-End", "Confidence", "Mode"], applied_rows)}

## Skipped jobs

{markdown_table(["Ref", "Reason", "Mode"], skipped_rows)}

## Failed jobs

{markdown_table(["Ref", "Error", "Mode"], failed_rows)}

## Workload warnings

{markdown_table(["Resource", "Date", "Jobs", "Refs"], warning_rows)}

## Manual review

{markdown_table(["Ref", "Reason"], manual_rows)}
"""
    path.write_text(content, encoding="utf-8")
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the daily BTR allocation workflow")
    parser.add_argument("--apply", action="store_true", help="Write schedules to BigChange and append audit records")
    args = parser.parse_args()

    started_at = dt.datetime.now(dt.timezone.utc).isoformat()
    today = dt.date.today()
    rules = load_rules()
    audited_refs = load_audited_refs()
    client = BigChangeClient()
    resources = client.resources()
    print(json.dumps({"resources": len(resources), "active_btr_resources": len(active_site_resources(resources, rules))}, indent=2))

    all_applied: list[dict[str, Any]] = []
    all_skipped: list[dict[str, Any]] = []
    all_failed: list[dict[str, Any]] = []
    all_manual: list[dict[str, Any]] = []

    stale_applied, stale_skipped, stale_failed, stale_manual = run_stale_reschedules(
        client,
        rules,
        resources,
        audited_refs,
        apply=args.apply,
        today=today,
    )
    all_applied.extend(stale_applied)
    all_skipped.extend(stale_skipped)
    all_failed.extend(stale_failed)
    all_manual.extend(stale_manual)

    alloc_applied, alloc_skipped, alloc_failed, alloc_manual = run_unallocated_allocations(
        client,
        rules,
        audited_refs,
        apply=args.apply,
    )
    all_applied.extend(alloc_applied)
    all_skipped.extend(alloc_skipped)
    all_failed.extend(alloc_failed)
    all_manual.extend(alloc_manual)

    warnings = workload_warnings(client, rules, resources, today=today)
    summary_path = write_summary(
        today=today,
        started_at=started_at,
        apply=args.apply,
        applied=all_applied,
        skipped=all_skipped,
        failed=all_failed,
        manual=all_manual,
        warnings=warnings,
    )

    print(
        json.dumps(
            {
                "summary": str(summary_path.relative_to(ROOT)),
                "applied": len(all_applied),
                "failed": len(all_failed),
                "skipped": len(all_skipped),
                "manual_review": len(all_manual),
                "workload_warnings": len(warnings),
            },
            indent=2,
        )
    )
    return 0 if not all_failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
