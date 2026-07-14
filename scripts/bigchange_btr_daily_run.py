#!/usr/bin/env python3
"""Daily BigChange BTR allocation runner.

This is the cron-friendly orchestration layer for the BTR allocation workflow.
It reuses the site/resource/slot logic from bigchange_btr_allocation.py, applies
eligible allocations by default, and always writes a markdown summary so setup
or API failures are auditable.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from bigchange_btr_allocation import (  # noqa: E402
    CLOSED_STATUS_IDS,
    BigChangeClient,
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
DEFAULT_LOOKBACK_DAYS = 14
DEFAULT_SEARCH_DAYS = 14
REQUIRED_BIGCHANGE_ENV = (
    "BIGCHANGE_USERNAME",
    "BIGCHANGE_PASSWORD",
    "BIGCHANGE_API_KEY",
)


def as_int(value: Any, default: int | None = None) -> int | None:
    if value in (None, ""):
        return default
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


def load_dotenv_if_present(path: Path = ROOT / ".env") -> None:
    """Load a local .env when present without overriding runtime secrets."""
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue
        os.environ[key] = value.strip().strip('"').strip("'")


def validate_bigchange_env() -> None:
    missing = [name for name in REQUIRED_BIGCHANGE_ENV if not os.environ.get(name)]
    if missing:
        raise RuntimeError(f"Missing required environment variables: {', '.join(missing)}")


def fetch_job(client: BigChangeClient, *, job_id: int | None = None, job_ref: str | None = None) -> dict[str, Any] | None:
    params: dict[str, Any] = {}
    if job_id:
        params["JobId"] = job_id
    elif job_ref:
        params["JobRef"] = job_ref
    else:
        return None
    payload = client.get("Job", params)
    if payload.get("Code") not in (0, None, "0"):
        return None
    result = payload.get("Result")
    if isinstance(result, list) and result:
        return result[0] if isinstance(result[0], dict) else None
    if isinstance(result, dict):
        return result
    return None


def load_audit_records(path: Path = AUDIT_PATH) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    if not path.exists():
        return records
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Invalid audit JSON on line {line_number}: {exc}") from exc
        if isinstance(record, dict):
            records.append(record)
    return records


def append_audit(record: dict[str, Any], path: Path = AUDIT_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")


def audited_refs(records: list[dict[str, Any]]) -> set[str]:
    return {str(record.get("job_ref") or "") for record in records if record.get("job_ref")}


def resource_label(resource: dict[str, Any]) -> str:
    return str(resource.get("label") or resource.get("Resource") or resource.get("Name") or "")


def resource_id(resource: dict[str, Any]) -> int | None:
    return as_int(resource.get("id") or resource.get("ResourceId") or resource.get("ResId"))


def active_btr_resources(resources: list[dict[str, Any]], rules: dict[str, Any]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for resource in resources:
        name = resource_label(resource)
        rid = resource_id(resource)
        if rid is None:
            continue
        if not resource_is_active_for_jobwatch(resource):
            continue
        if resource_is_excluded(name, rules):
            continue
        site = resource_site(name, rules)
        role = resource_role(name, rules)
        if not site or not role:
            continue
        candidates.append({**resource, "_id": rid, "_name": name, "_site": site, "_role": role})
    return candidates


def resource_short_name(full_name: str) -> str:
    if " - " in full_name:
        return full_name.split(" - ", 1)[1].strip()
    parts = full_name.split()
    if len(parts) >= 2:
        return " ".join(parts[-2:])
    return full_name.strip()


def job_ref(job: dict[str, Any]) -> str:
    return str(job.get("Ref") or "")


def open_status(job: dict[str, Any]) -> bool:
    status_id = as_int(job.get("StatusId"))
    if status_id in CLOSED_STATUS_IDS:
        return False
    if normalise(job.get("Status")) in {"complete", "completed", "done"}:
        return False
    if is_cancelled_diary_job(job):
        return False
    return True


def site_for_diary_job(job: dict[str, Any], resource: dict[str, Any], rules: dict[str, Any]) -> tuple[str | None, str]:
    """Identify stale-diary site, trusting the assigned BTR resource first."""
    from_resource = resource.get("_site") or resource_site(resource.get("_name", ""), rules)
    if from_resource:
        return str(from_resource), "Matched from currently assigned resource"
    match = identify_site(job, rules)
    if match:
        return match.site, match.method
    return None, "Site could not be identified"


def find_slot_for_resource(
    client: BigChangeClient,
    resource: dict[str, Any],
    rules: dict[str, Any],
    duration_minutes: int,
    *,
    search_days: int = DEFAULT_SEARCH_DAYS,
) -> Any | None:
    rid = int(resource["_id"])
    start_day = dt.date.today()
    end_day = start_day + dt.timedelta(days=search_days)
    diary = client.resource_diary(rid, start_day, end_day)
    schedule_jobs = [job for job in diary if not is_cancelled_diary_job(job)]
    working_hours_cache: dict[int, list[dict[str, Any]]] = {}

    for offset in range(search_days + 1):
        day = start_day + dt.timedelta(days=offset)
        if day.weekday() >= 5:
            continue
        windows = resource_working_windows(client, rid, day, working_hours_cache, rules)
        blocks = diary_blocks(schedule_jobs, day)
        slot = find_slot(blocks, day, duration_minutes, windows)
        if not slot:
            continue
        slot_start = dt.datetime.combine(day, slot.start)
        slot_end = dt.datetime.combine(day, slot.end)
        if slot_has_overlap(blocks, slot_start, slot_end):
            continue
        slot.booking_before, slot.booking_after = adjacent_bookings(blocks, slot_start, slot_end)
        return slot
    return None


def build_incomplete_recommendation(
    client: BigChangeClient,
    job: dict[str, Any],
    resource: dict[str, Any],
    rules: dict[str, Any],
) -> Recommendation | tuple[str, str]:
    ref = job_ref(job)
    excluded, exclusion_reason = contractor_exclusion(job, rules)
    if excluded:
        return ref, exclusion_reason
    if is_ppm_job(job):
        return ref, "PPM stale diary entry requires manual review only"

    site, site_method = site_for_diary_job(job, resource, rules)
    if not site:
        return ref, site_method

    resource_name = str(resource["_name"])
    role = resource.get("_role") or resource_role(resource_name, rules)
    role_match = determine_role(job)
    required_role = role_match.role or role or "Tech"
    duration, duration_reason, duration_confidence = estimate_duration(job, rules)
    slot = find_slot_for_resource(client, resource, rules, duration)
    if not slot:
        return ref, f"No suitable diary slot found for existing resource {resource_name}"

    confidence_parts = [role_match.confidence if role_match.role else "Medium", duration_confidence]
    confidence = "Low" if "Low" in confidence_parts else "Medium" if "Medium" in confidence_parts else "High"
    planned_start = parse_datetime(job.get("PlannedStart"))

    return Recommendation(
        job_ref=ref,
        job_id=int(job.get("JobId") or 0),
        site=site,
        site_identification=site_method,
        description=str(job.get("Description") or "")[:500],
        status=str(job.get("Status") or ""),
        flags=str(job.get("CurrentFlag") or "None"),
        required_role=required_role,
        proposed_resource=resource_name,
        proposed_resource_id=int(resource["_id"]),
        proposed_date=slot.date.isoformat(),
        proposed_start=slot.start.strftime("%H:%M"),
        proposed_end=slot.end.strftime("%H:%M"),
        duration_minutes=slot.duration_minutes,
        duration_reason=duration_reason,
        resource_reason=(
            f"Kept same active JobWatch resource {resource_name} for stale non-PPM diary job; "
            f"site inferred from resource where needed. Working slot avoids all non-cancelled bookings."
        ),
        contractor_check="Passed",
        ppm_check="Not a PPM job",
        overlap_check="Passed",
        booking_before=slot.booking_before,
        booking_after=slot.booking_after,
        priority=str(job.get("CurrentFlag") or job.get("Status") or "Routine"),
        target_date=str(job.get("DueDate") or "Not specified"),
        confidence=confidence,
        assumptions=[f"Original planned start: {planned_start}" if planned_start else "Original planned start not returned"],
    )


def fetch_incomplete_diary_jobs(
    client: BigChangeClient,
    resources: list[dict[str, Any]],
    rules: dict[str, Any],
    *,
    lookback_days: int,
    today: dt.date,
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    start = today - dt.timedelta(days=lookback_days)
    end = today - dt.timedelta(days=1)
    candidates: list[dict[str, Any]] = []
    manual_review: list[dict[str, str]] = []
    seen: set[tuple[str, int]] = set()

    for resource in resources:
        diary = client.resource_diary(int(resource["_id"]), start, end)
        for job in diary:
            planned = parse_datetime(job.get("PlannedStart"))
            if not planned or planned.date() >= today:
                continue
            if not open_status(job):
                continue
            site, site_method = site_for_diary_job(job, resource, rules)
            if not site:
                continue
            key = (job_ref(job), int(resource["_id"]))
            if key in seen:
                continue
            seen.add(key)
            if is_ppm_job(job):
                manual_review.append(
                    {
                        "ref": job_ref(job),
                        "reason": "PPM stale diary entry requires manual review only",
                        "site": site,
                        "resource": str(resource["_name"]),
                    }
                )
                continue
            candidates.append({"job": job, "resource": resource, "site": site, "site_method": site_method})
    return candidates, manual_review


def verify_schedule(client: BigChangeClient, recommendation: Recommendation) -> list[str]:
    warnings: list[str] = []
    job = fetch_job(client, job_id=recommendation.job_id)
    planned = parse_datetime(job.get("PlannedStart")) if job else None
    resource_text = normalise(job.get("Resource")) if job else ""
    expected_start = dt.datetime.strptime(
        f"{recommendation.proposed_date} {recommendation.proposed_start}", "%Y-%m-%d %H:%M"
    )

    if not job:
        warnings.append("Verification could not fetch job after scheduling")
    else:
        if not planned or planned != expected_start:
            warnings.append("Verification did not find the expected planned start on the job")
        if not resource_text:
            warnings.append("Verification found planned job without a resource")

    diary = client.resource_diary(
        recommendation.proposed_resource_id,
        expected_start.date(),
        expected_start.date(),
    )
    diary_refs = {job_ref(entry) for entry in diary}
    if recommendation.job_ref not in diary_refs:
        warnings.append("Verification did not find job on intended resource diary")
    return warnings


def apply_recommendation(
    client: BigChangeClient,
    recommendation: Recommendation,
    *,
    mode: str,
    dry_run: bool,
    original_date: str | None = None,
) -> dict[str, Any]:
    record = {
        "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
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
        "mode": f"dry_run_{mode}" if dry_run else mode,
        "overlap_check": recommendation.overlap_check,
    }
    if original_date:
        record["original_date"] = original_date
    if dry_run:
        return record

    schedule_dt = f"{recommendation.proposed_date} {recommendation.proposed_start}:00"
    client.schedule_job(
        recommendation.job_id,
        recommendation.proposed_resource_id,
        schedule_dt,
        recommendation.duration_minutes,
    )
    verification_warnings = verify_schedule(client, recommendation)
    if any("without a resource" in warning or "resource diary" in warning for warning in verification_warnings):
        client.schedule_job(
            recommendation.job_id,
            recommendation.proposed_resource_id,
            schedule_dt,
            recommendation.duration_minutes,
        )
        verification_warnings = verify_schedule(client, recommendation)
    if verification_warnings:
        record["verification_warnings"] = verification_warnings
    append_audit(record)
    return record


def should_skip_audited(job: dict[str, Any], already_audited: set[str]) -> bool:
    ref = job_ref(job)
    if ref not in already_audited:
        return False
    return not is_unallocated(job)


def row_from_record(record: dict[str, Any]) -> dict[str, str]:
    return {
        "ref": str(record.get("job_ref") or record.get("ref") or ""),
        "site": str(record.get("site") or ""),
        "resource": str(record.get("resource") or ""),
        "date": str(record.get("scheduled_date") or ""),
        "time": f"{record.get('start', '')}-{record.get('end', '')}",
        "confidence": str(record.get("confidence") or ""),
        "mode": str(record.get("mode") or ""),
    }


def markdown_table(headers: list[str], rows: list[list[Any]]) -> str:
    if not rows:
        return "_None_"
    rendered = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    for row in rows:
        rendered.append("| " + " | ".join(str(cell).replace("\n", " ") for cell in row) + " |")
    return "\n".join(rendered)


def write_summary(
    *,
    run_date: dt.date,
    run_timestamp: str,
    applied: list[dict[str, Any]],
    skipped: list[dict[str, str]],
    failed: list[dict[str, str]],
    workload_warnings: list[str],
    manual_review: list[dict[str, str]],
    dry_run: bool,
) -> Path:
    path = SUMMARY_DIR / f"btr-daily-run-{run_date.isoformat()}.md"
    skip_counts = Counter(item.get("reason", "unspecified") for item in skipped)
    applied_rows = [
        [
            row["ref"],
            row["site"],
            row["resource"],
            row["date"],
            row["time"],
            row["confidence"],
            row["mode"],
        ]
        for row in (row_from_record(record) for record in applied)
    ]
    skipped_rows = [[item.get("ref", ""), item.get("reason", "")] for item in skipped]
    failed_rows = [[item.get("ref", ""), item.get("error", "")] for item in failed]
    manual_rows = [[item.get("ref", ""), item.get("site", ""), item.get("reason", "")] for item in manual_review]
    low_confidence = [record for record in applied if str(record.get("confidence")).lower() == "low"]

    content = [
        f"# BTR Daily Run - {run_date.isoformat()}",
        "",
        f"- Run timestamp: {run_timestamp}",
        f"- Mode: {'dry run' if dry_run else 'apply'}",
        f"- Applied: {len(applied)}",
        f"- Failed: {len(failed)}",
        f"- Skipped: {len(skipped)}",
        "",
        "## Skipped by reason",
        "",
        markdown_table(["Reason", "Count"], [[reason, count] for reason, count in sorted(skip_counts.items())]),
        "",
        "## Applied jobs",
        "",
        markdown_table(["Ref", "Site", "Resource", "Date", "Start-End", "Confidence", "Mode"], applied_rows),
        "",
        "## Skipped jobs",
        "",
        markdown_table(["Ref", "Reason"], skipped_rows),
        "",
        "## Failed jobs",
        "",
        markdown_table(["Ref", "Error"], failed_rows),
        "",
        "## Workload warnings",
        "",
        "\n".join(f"- {warning}" for warning in workload_warnings) if workload_warnings else "_None_",
        "",
        "## Manual review",
        "",
        markdown_table(["Ref", "Site", "Reason"], manual_rows),
        "",
        "## Low-confidence applied jobs",
        "",
        markdown_table(
            ["Ref", "Site", "Resource", "Date", "Start-End"],
            [
                [
                    row_from_record(record)["ref"],
                    row_from_record(record)["site"],
                    row_from_record(record)["resource"],
                    row_from_record(record)["date"],
                    row_from_record(record)["time"],
                ]
                for record in low_confidence
            ],
        ),
        "",
    ]
    path.write_text("\n".join(content), encoding="utf-8")
    return path


def workload_warnings_for_applied(
    client: BigChangeClient,
    resources: list[dict[str, Any]],
    applied: list[dict[str, Any]],
) -> list[str]:
    if not applied:
        return []
    dates = sorted({dt.date.fromisoformat(str(record["scheduled_date"])) for record in applied if record.get("scheduled_date")})
    if not dates:
        return []
    resources_by_id = {int(resource["_id"]): resource for resource in resources}
    warnings: list[str] = []
    for rid in sorted({int(record["resource_id"]) for record in applied if record.get("resource_id")}):
        resource = resources_by_id.get(rid)
        name = str(resource.get("_name") if resource else rid)
        for day in dates:
            diary = client.resource_diary(rid, day, day)
            count = 0
            for entry in diary:
                if is_cancelled_diary_job(entry):
                    continue
                planned = parse_datetime(entry.get("PlannedStart"))
                if planned and planned.date() == day:
                    count += 1
            if count >= 4:
                warnings.append(f"{name} has {count} non-cancelled planned jobs on {day.isoformat()}")
    return warnings


def run_daily(*, lookback_days: int, dry_run: bool, run_date: dt.date | None = None) -> dict[str, Any]:
    run_date = run_date or dt.date.today()
    run_timestamp = dt.datetime.now(dt.timezone.utc).isoformat()
    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    failed: list[dict[str, str]] = []
    manual_review: list[dict[str, str]] = []
    workload_warnings: list[str] = []

    try:
        load_dotenv_if_present()
        validate_bigchange_env()
        rules = load_rules()
        audit_records = load_audit_records()
        already_audited = audited_refs(audit_records)
        client = BigChangeClient()
        resources = active_btr_resources(client.resources(), rules)
    except Exception as exc:
        failed.append({"ref": "SETUP", "error": str(exc)})
        summary_path = write_summary(
            run_date=run_date,
            run_timestamp=run_timestamp,
            applied=applied,
            skipped=skipped,
            failed=failed,
            workload_warnings=workload_warnings,
            manual_review=manual_review,
            dry_run=dry_run,
        )
        return {
            "applied": applied,
            "skipped": skipped,
            "failed": failed,
            "manual_review": manual_review,
            "workload_warnings": workload_warnings,
            "summary_path": str(summary_path),
        }

    try:
        incomplete, stale_ppm = fetch_incomplete_diary_jobs(
            client,
            resources,
            rules,
            lookback_days=lookback_days,
            today=run_date,
        )
    except Exception as exc:
        incomplete, stale_ppm = [], []
        failed.append({"ref": "INCOMPLETE_FETCH", "error": str(exc)})
    manual_review.extend(stale_ppm)
    skipped.extend(stale_ppm)

    for item in incomplete:
        job = item["job"]
        ref = job_ref(job)
        planned = parse_datetime(job.get("PlannedStart"))
        if ref in already_audited:
            skipped.append({"ref": ref, "reason": "already actioned in audit log"})
            continue
        result = build_incomplete_recommendation(client, job, item["resource"], rules)
        if isinstance(result, tuple):
            skipped.append({"ref": result[0], "reason": result[1]})
            continue
        try:
            record = apply_recommendation(
                client,
                result,
                mode="daily_incomplete_reschedule",
                dry_run=dry_run,
                original_date=planned.date().isoformat() if planned else None,
            )
            applied.append(record)
            already_audited.add(ref)
        except Exception as exc:
            failed.append({"ref": ref, "error": str(exc)})

    try:
        unallocated_jobs = fetch_unallocated_jobs(client, lookback_days=lookback_days)
    except Exception as exc:
        unallocated_jobs = []
        failed.append({"ref": "UNALLOCATED_FETCH", "error": str(exc)})
    for job in unallocated_jobs:
        ref = job_ref(job)
        site_match = identify_site(job, rules)
        if not site_match:
            continue
        excluded, exclusion_reason = contractor_exclusion(job, rules)
        if excluded:
            skipped.append({"ref": ref, "reason": exclusion_reason})
            manual_review.append({"ref": ref, "site": site_match.site, "reason": exclusion_reason})
            continue
        ppm_allowed, ppm_reason = ppm_tech_diary_review(job, rules)
        if not ppm_allowed:
            skipped.append({"ref": ref, "reason": ppm_reason})
            manual_review.append({"ref": ref, "site": site_match.site, "reason": ppm_reason})
            continue
        if should_skip_audited(job, already_audited):
            skipped.append({"ref": ref, "reason": "already actioned in audit log"})
            continue
        result = build_recommendation(client, job, rules)
        if isinstance(result, tuple):
            skipped.append({"ref": result[0], "reason": result[1]})
            if "contractor" in result[1].lower() or "ppm" in result[1].lower() or "no suitable" in result[1].lower():
                manual_review.append({"ref": result[0], "site": site_match.site, "reason": result[1]})
            continue
        try:
            mode = f"daily_allocate_{result.confidence.lower()}"
            record = apply_recommendation(client, result, mode=mode, dry_run=dry_run)
            applied.append(record)
            already_audited.add(ref)
            if result.confidence == "Low":
                manual_review.append({"ref": ref, "site": result.site, "reason": "Low-confidence allocation applied"})
        except Exception as exc:
            failed.append({"ref": ref, "error": str(exc)})

    try:
        workload_warnings = workload_warnings_for_applied(client, resources, applied)
    except Exception as exc:
        workload_warnings = [f"Workload sanity check failed: {exc}"]

    summary_path = write_summary(
        run_date=run_date,
        run_timestamp=run_timestamp,
        applied=applied,
        skipped=skipped,
        failed=failed,
        workload_warnings=workload_warnings,
        manual_review=manual_review,
        dry_run=dry_run,
    )
    return {
        "applied": applied,
        "skipped": skipped,
        "failed": failed,
        "manual_review": manual_review,
        "workload_warnings": workload_warnings,
        "summary_path": str(summary_path),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run daily BTR BigChange allocation workflow")
    parser.add_argument("--lookback-days", type=int, default=DEFAULT_LOOKBACK_DAYS)
    parser.add_argument("--dry-run", action="store_true", help="Recommend and summarize without calling JobSchedule")
    parser.add_argument("--run-date", help="Override run date (YYYY-MM-DD), mainly for tests/backfills")
    args = parser.parse_args()

    run_date = dt.date.fromisoformat(args.run_date) if args.run_date else None
    result = run_daily(lookback_days=args.lookback_days, dry_run=args.dry_run, run_date=run_date)
    print(
        json.dumps(
            {
                "applied": len(result["applied"]),
                "skipped": len(result["skipped"]),
                "failed": len(result["failed"]),
                "manual_review": len(result["manual_review"]),
                "summary_path": result["summary_path"],
            },
            indent=2,
        )
    )
    return 0 if not result["failed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
