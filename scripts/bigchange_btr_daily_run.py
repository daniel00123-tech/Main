#!/usr/bin/env python3
"""Run the daily BigChange BTR allocation workflow.

This script discovers current BTR stale-diary and unallocated jobs from the
BigChange TEST API, applies the established allocation rules, appends applied
actions to the audit log, and writes a markdown daily summary.
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
    CLOSED_STATUS_IDS,
    BigChangeClient,
    Recommendation,
    adjacent_bookings,
    as_int,
    build_recommendation,
    diary_blocks,
    fetch_unallocated_jobs,
    find_slot,
    identify_site,
    is_cancelled_diary_job,
    is_ppm_job,
    load_rules,
    normalise,
    parse_datetime,
    parse_duration,
    resource_is_active_for_jobwatch,
    resource_is_excluded,
    resource_role,
    resource_site,
    resource_working_windows,
    slot_has_overlap,
)


AUDIT_PATH = ROOT / "automation-memory/btr-allocation-audit.jsonl"
SUMMARY_DIR = ROOT / "automation-memory"
SUMMARY_PATH_TEMPLATE = "btr-daily-run-{date}.md"
LOOKBACK_DAYS = 14
SEARCH_DAYS = 14


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def markdown_escape(value: Any) -> str:
    text = str(value if value is not None else "")
    return text.replace("\n", " ").replace("|", "\\|")


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
    if isinstance(result, dict):
        return result
    return None


def is_closed_job(job: dict[str, Any]) -> bool:
    status = normalise(job.get("Status"))
    if any(term in status for term in ("complete", "cancel", "deleted", "rejected")):
        return True
    status_id = as_int(job.get("StatusId"))
    return status_id in CLOSED_STATUS_IDS


def active_btr_resources(resources: list[dict[str, Any]], rules: dict[str, Any]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
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
        candidates.append(resource)
    return candidates


def resource_name(resource: dict[str, Any]) -> str:
    return str(resource.get("label") or "")


def next_schedulable_day(today: dt.date) -> dt.date:
    current = today
    while current.weekday() >= 5:
        current += dt.timedelta(days=1)
    return current


def planned_duration(job: dict[str, Any]) -> int:
    duration = parse_duration(job.get("Duration")) or parse_duration(job.get("RealDuration")) or 60
    return max(60, min(540, round(duration / 30) * 30))


def find_resource_slot(
    client: BigChangeClient,
    resource_id: int,
    duration_minutes: int,
    rules: dict[str, Any],
    *,
    start_day: dt.date | None = None,
    search_days: int = SEARCH_DAYS,
    exclude_job_id: int | None = None,
) -> tuple[Any | None, list[str]]:
    start = start_day or next_schedulable_day(dt.date.today())
    end = start + dt.timedelta(days=search_days)
    diary = client.resource_diary(resource_id, start, end)
    schedule_jobs = []
    for entry in diary:
        if exclude_job_id is not None and as_int(entry.get("JobId")) == exclude_job_id:
            continue
        if not is_cancelled_diary_job(entry):
            schedule_jobs.append(entry)

    working_hours_cache: dict[int, list[dict[str, Any]]] = {}
    for offset in range(search_days + 1):
        day = start + dt.timedelta(days=offset)
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
        return slot, []
    return None, ["No suitable diary slot found within search window"]


def job_in_resource_diary(
    client: BigChangeClient,
    resource_id: int,
    job_id: int,
    day: dt.date,
) -> dict[str, Any] | None:
    for entry in client.resource_diary(resource_id, day, day):
        if as_int(entry.get("JobId")) == job_id:
            return entry
    return None


def verify_scheduled_job(
    client: BigChangeClient,
    *,
    job_id: int,
    resource_id: int,
    day: dt.date,
) -> tuple[bool, str]:
    job = fetch_job(client, job_id=job_id) or {}
    planned_start = parse_datetime(job.get("PlannedStart"))
    if not planned_start:
        return False, "Scheduled job has no PlannedStart after JobSchedule"
    resource = normalise(job.get("Resource"))
    if not resource:
        return False, "Scheduled job has PlannedStart but no Resource after JobSchedule"

    diary_entry = job_in_resource_diary(client, resource_id, job_id, day)
    if not diary_entry:
        return False, "Scheduled job does not appear on intended resource diary"

    start = parse_datetime(diary_entry.get("PlannedStart"))
    end = parse_datetime(diary_entry.get("PlannedEnd"))
    if not start:
        return False, "Diary entry has no PlannedStart"
    if not end:
        duration = parse_duration(diary_entry.get("Duration")) or 60
        end = start + dt.timedelta(minutes=duration)

    other_entries = [
        entry
        for entry in client.resource_diary(resource_id, day, day)
        if as_int(entry.get("JobId")) != job_id and not is_cancelled_diary_job(entry)
    ]
    for block_start, block_end, label in diary_blocks(other_entries, day):
        if slot_has_overlap([(block_start, block_end, label)], start, end):
            return False, f"Scheduled job overlaps existing diary booking: {label}"
    return True, "Verified on intended diary with no overlap involving scheduled job"


def schedule_and_verify(
    client: BigChangeClient,
    *,
    job_id: int,
    resource_id: int,
    schedule_date: dt.date,
    start_time: dt.time,
    duration_minutes: int,
    rules: dict[str, Any],
) -> tuple[dt.date, dt.time, dt.time, str]:
    schedule_dt = f"{schedule_date.isoformat()} {start_time.strftime('%H:%M')}:00"
    client.schedule_job(job_id, resource_id, schedule_dt, duration_minutes)
    ok, message = verify_scheduled_job(client, job_id=job_id, resource_id=resource_id, day=schedule_date)
    if ok:
        return schedule_date, start_time, (dt.datetime.combine(schedule_date, start_time) + dt.timedelta(minutes=duration_minutes)).time(), message

    slot, warnings = find_resource_slot(
        client,
        resource_id,
        duration_minutes,
        rules,
        start_day=next_schedulable_day(dt.date.today()),
        exclude_job_id=job_id,
    )
    if not slot:
        raise RuntimeError(f"{message}; retry failed: {'; '.join(warnings)}")
    retry_dt = f"{slot.date.isoformat()} {slot.start.strftime('%H:%M')}:00"
    client.schedule_job(job_id, resource_id, retry_dt, duration_minutes)
    ok, retry_message = verify_scheduled_job(client, job_id=job_id, resource_id=resource_id, day=slot.date)
    if not ok:
        raise RuntimeError(f"{message}; retry verification failed: {retry_message}")
    return slot.date, slot.start, slot.end, f"{message}; re-applied. {retry_message}"


def collect_incomplete_candidates(
    client: BigChangeClient,
    resources: list[dict[str, Any]],
    rules: dict[str, Any],
    lookback_days: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    today = dt.date.today()
    start = today - dt.timedelta(days=lookback_days)
    end = today - dt.timedelta(days=1)
    if end < start:
        return [], []

    candidates_by_ref: dict[str, dict[str, Any]] = {}
    ppm_manual_by_ref: dict[str, dict[str, Any]] = {}
    for resource in resources:
        rid = int(resource["id"])
        name = resource_name(resource)
        site = resource_site(name, rules)
        role = resource_role(name, rules)
        if not site or not role:
            continue
        diary = client.resource_diary(rid, start, end)
        for job in diary:
            ref = str(job.get("Ref") or "").strip()
            if not ref:
                continue
            planned_start = parse_datetime(job.get("PlannedStart"))
            if not planned_start or planned_start.date() >= today:
                continue
            if is_closed_job(job):
                continue
            item = {
                "job": job,
                "job_id": int(job.get("JobId") or 0),
                "ref": ref,
                "site": site,
                "role": role,
                "resource": name,
                "resource_id": rid,
                "planned_start": planned_start,
            }
            if is_ppm_job(job):
                ppm_manual_by_ref.setdefault(ref, {**item, "reason": "stale PPM diary entry requires manual review"})
                continue
            existing = candidates_by_ref.get(ref)
            if not existing or planned_start < existing["planned_start"]:
                candidates_by_ref[ref] = item
    return list(candidates_by_ref.values()), list(ppm_manual_by_ref.values())


def apply_incomplete_reschedules(
    client: BigChangeClient,
    candidates: list[dict[str, Any]],
    audit_refs: set[str],
    rules: dict[str, Any],
    *,
    dry_run: bool,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []

    for item in sorted(candidates, key=lambda row: (row["planned_start"], row["ref"])):
        ref = item["ref"]
        if ref in audit_refs:
            skipped.append({"ref": ref, "reason": "already actioned in audit log", "mode": "daily_incomplete_reschedule"})
            continue
        duration = planned_duration(item["job"])
        try:
            slot, warnings = find_resource_slot(client, item["resource_id"], duration, rules)
            if not slot:
                skipped.append({"ref": ref, "reason": "; ".join(warnings), "mode": "daily_incomplete_reschedule"})
                continue
            if dry_run:
                scheduled_date, start_time, end_time, verify_message = slot.date, slot.start, slot.end, "dry run"
            else:
                scheduled_date, start_time, end_time, verify_message = schedule_and_verify(
                    client,
                    job_id=item["job_id"],
                    resource_id=item["resource_id"],
                    schedule_date=slot.date,
                    start_time=slot.start,
                    duration_minutes=duration,
                    rules=rules,
                )
            record = {
                "timestamp": utc_now().isoformat(),
                "job_ref": ref,
                "job_id": item["job_id"],
                "site": item["site"],
                "resource": item["resource"],
                "resource_id": item["resource_id"],
                "scheduled_date": scheduled_date.isoformat(),
                "start": start_time.strftime("%H:%M"),
                "end": end_time.strftime("%H:%M"),
                "duration_minutes": duration,
                "confidence": "High",
                "mode": "daily_incomplete_reschedule",
                "original_date": item["planned_start"].date().isoformat(),
                "overlap_check": "Passed",
                "verification": verify_message,
            }
            if not dry_run:
                append_audit(record)
                audit_refs.add(ref)
            applied.append(record)
        except Exception as exc:  # noqa: BLE001 - continue daily batch on individual failures
            failed.append({"ref": ref, "error": str(exc), "mode": "daily_incomplete_reschedule"})
    return applied, skipped, failed


def recommendation_record(recommendation: Recommendation, mode: str, verification: str) -> dict[str, Any]:
    return {
        "timestamp": utc_now().isoformat(),
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
        "verification": verification,
    }


def apply_unallocated_jobs(
    client: BigChangeClient,
    rules: dict[str, Any],
    audit_refs: set[str],
    *,
    lookback_days: int,
    dry_run: bool,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], int]:
    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    non_btr_count = 0

    jobs = fetch_unallocated_jobs(client, lookback_days=lookback_days)
    btr_jobs: list[dict[str, Any]] = []
    for job in jobs:
        if identify_site(job, rules):
            btr_jobs.append(job)
        else:
            non_btr_count += 1

    def confidence_rank(job: dict[str, Any]) -> tuple[int, str]:
        result = build_recommendation(client, job, rules)
        if isinstance(result, tuple):
            return (99, str(job.get("Ref") or ""))
        return ({"High": 0, "Medium": 1, "Low": 2}.get(result.confidence, 99), result.job_ref)

    for job in sorted(btr_jobs, key=confidence_rank):
        ref = str(job.get("Ref") or "").strip()
        try:
            result = build_recommendation(client, job, rules)
            if isinstance(result, tuple):
                reason = result[1]
                site = identify_site(job, rules)
                if site and site.site == "Baltic Yard" and "No suitable active" in reason:
                    reason = "no suitable resource (Baltic Yard has no active matching Tech/CT/HK resource)"
                skipped.append({"ref": ref, "reason": reason, "mode": "daily_allocate"})
                continue
            if ref in audit_refs:
                # Re-action is allowed only because this live job is still unallocated.
                result.assumptions.append("Job appears in audit log but is currently unallocated; re-actioning")
            mode = f"daily_allocate_{result.confidence.lower()}"
            if dry_run:
                verification = "dry run"
            else:
                scheduled_date, start_time, end_time, verification = schedule_and_verify(
                    client,
                    job_id=result.job_id,
                    resource_id=result.proposed_resource_id,
                    schedule_date=dt.date.fromisoformat(result.proposed_date),
                    start_time=dt.datetime.strptime(result.proposed_start, "%H:%M").time(),
                    duration_minutes=result.duration_minutes,
                    rules=rules,
                )
                result.proposed_date = scheduled_date.isoformat()
                result.proposed_start = start_time.strftime("%H:%M")
                result.proposed_end = end_time.strftime("%H:%M")
            record = recommendation_record(result, mode, verification)
            if not dry_run:
                append_audit(record)
                audit_refs.add(ref)
            applied.append(record)
        except Exception as exc:  # noqa: BLE001 - continue daily batch on individual failures
            failed.append({"ref": ref, "error": str(exc), "mode": "daily_allocate"})
    return applied, skipped, failed, non_btr_count


def workload_warnings(client: BigChangeClient, records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_resource_day = sorted(
        {
            (as_int(record.get("resource_id")), str(record.get("resource")), str(record.get("scheduled_date")))
            for record in records
            if record.get("resource_id") and record.get("scheduled_date")
        }
    )
    warnings: list[dict[str, Any]] = []
    for resource_id, resource, day_text in by_resource_day:
        if not resource_id:
            continue
        try:
            day = dt.date.fromisoformat(day_text)
        except ValueError:
            continue
        diary = client.resource_diary(resource_id, day, day)
        open_jobs = [job for job in diary if not is_cancelled_diary_job(job) and not is_closed_job(job)]
        if len(open_jobs) >= 4:
            warnings.append(
                {
                    "resource": resource,
                    "resource_id": resource_id,
                    "date": day_text,
                    "job_count": len(open_jobs),
                    "refs": ", ".join(str(job.get("Ref") or "") for job in open_jobs if job.get("Ref")),
                }
            )
    return warnings


def render_table(headers: list[str], rows: list[list[Any]]) -> str:
    if not rows:
        return "_None._\n"
    output = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    for row in rows:
        output.append("| " + " | ".join(markdown_escape(value) for value in row) + " |")
    return "\n".join(output) + "\n"


def write_summary(
    *,
    summary_path: Path,
    run_started: dt.datetime,
    run_finished: dt.datetime,
    applied: list[dict[str, Any]],
    skipped: list[dict[str, Any]],
    failed: list[dict[str, Any]],
    manual_review: list[dict[str, Any]],
    workloads: list[dict[str, Any]],
    non_btr_count: int,
    dry_run: bool,
) -> None:
    skipped_counts = Counter(str(item.get("reason") or "unspecified") for item in skipped)
    lines = [
        f"# BTR Daily Run — {run_started.date().isoformat()}",
        "",
        f"- Run started: {run_started.isoformat()}",
        f"- Run finished: {run_finished.isoformat()}",
        f"- Mode: {'dry run' if dry_run else 'applied to BigChange TEST'}",
        f"- Non-BTR unallocated jobs ignored: {non_btr_count}",
        "",
        "## Counts",
        "",
        f"- Applied: {len(applied)}",
        f"- Failed: {len(failed)}",
        f"- Skipped: {len(skipped)}",
        "",
        "### Skipped by reason",
        "",
    ]
    if skipped_counts:
        lines.extend(f"- {reason}: {count}" for reason, count in skipped_counts.most_common())
    else:
        lines.append("- None")
    lines.extend(
        [
            "",
            "## Applied jobs",
            "",
            render_table(
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
            render_table(
                ["Ref", "Reason", "Mode"],
                [[item.get("ref"), item.get("reason"), item.get("mode")] for item in skipped],
            ),
            "",
            "## Failed jobs",
            "",
            render_table(
                ["Ref", "Error", "Mode"],
                [[item.get("ref"), item.get("error"), item.get("mode")] for item in failed],
            ),
            "",
            "## Workload warnings",
            "",
            render_table(
                ["Resource", "Date", "Open job count", "Refs"],
                [[item.get("resource"), item.get("date"), item.get("job_count"), item.get("refs")] for item in workloads],
            ),
            "",
            "## Manual review / attention",
            "",
            render_table(
                ["Ref", "Reason", "Site/Resource", "Planned"],
                [
                    [
                        item.get("ref"),
                        item.get("reason"),
                        item.get("site") or item.get("resource"),
                        item.get("planned_start").date().isoformat()
                        if isinstance(item.get("planned_start"), dt.datetime)
                        else item.get("planned_start", ""),
                    ]
                    for item in manual_review
                ],
            ),
            "",
        ]
    )
    summary_path.write_text("\n".join(lines), encoding="utf-8")


def run(*, dry_run: bool, lookback_days: int) -> int:
    run_started = utc_now()
    summary_path = SUMMARY_DIR / SUMMARY_PATH_TEMPLATE.format(date=run_started.date().isoformat())
    audit_refs = load_audit_refs()

    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    manual_review: list[dict[str, Any]] = []
    workloads: list[dict[str, Any]] = []
    non_btr_count = 0

    try:
        rules = load_rules()
        client = BigChangeClient()
        resources = client.resources()
        btr_resources = active_btr_resources(resources, rules)

        incomplete, ppm_manual = collect_incomplete_candidates(client, btr_resources, rules, lookback_days)
        manual_review.extend(ppm_manual)
        phase_applied, phase_skipped, phase_failed = apply_incomplete_reschedules(
            client,
            incomplete,
            audit_refs,
            rules,
            dry_run=dry_run,
        )
        applied.extend(phase_applied)
        skipped.extend(phase_skipped)
        failed.extend(phase_failed)

        phase_applied, phase_skipped, phase_failed, non_btr_count = apply_unallocated_jobs(
            client,
            rules,
            audit_refs,
            lookback_days=lookback_days,
            dry_run=dry_run,
        )
        applied.extend(phase_applied)
        skipped.extend(phase_skipped)
        failed.extend(phase_failed)
        manual_review.extend(
            item
            for item in skipped
            if any(term in normalise(item.get("reason")) for term in ("ppm", "contractor", "aquilo", "baltic", "low"))
        )

        if not dry_run:
            workloads = workload_warnings(client, applied)
    except Exception as exc:  # noqa: BLE001 - still write a summary for auditability
        failed.append({"ref": "setup", "error": str(exc), "mode": "daily_setup"})

    run_finished = utc_now()
    write_summary(
        summary_path=summary_path,
        run_started=run_started,
        run_finished=run_finished,
        applied=applied,
        skipped=skipped,
        failed=failed,
        manual_review=manual_review,
        workloads=workloads,
        non_btr_count=non_btr_count,
        dry_run=dry_run,
    )
    print(
        json.dumps(
            {
                "summary": str(summary_path),
                "applied": len(applied),
                "skipped": len(skipped),
                "failed": len(failed),
                "manual_review": len(manual_review),
                "dry_run": dry_run,
            },
            indent=2,
        )
    )
    return 0 if not failed else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Run daily BTR allocation workflow")
    parser.add_argument("--dry-run", action="store_true", help="Evaluate and write summary without BigChange writes")
    parser.add_argument("--lookback-days", type=int, default=LOOKBACK_DAYS)
    args = parser.parse_args()
    return run(dry_run=args.dry_run, lookback_days=args.lookback_days)


if __name__ == "__main__":
    raise SystemExit(main())
