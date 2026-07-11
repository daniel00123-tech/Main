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
    Recommendation,
    as_int,
    build_recommendation,
    choose_resource,
    contractor_exclusion,
    determine_role,
    diary_blocks,
    estimate_duration,
    fetch_unallocated_jobs,
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


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def load_audited_refs(path: Path = AUDIT_PATH) -> set[str]:
    refs: set[str] = set()
    if not path.exists():
        return refs
    for line in path.read_text(encoding="utf-8").splitlines():
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


def append_audit(record: dict[str, Any], path: Path = AUDIT_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")


def fetch_job(client: BigChangeClient, *, job_id: int | None = None, job_ref: str | None = None) -> dict[str, Any] | None:
    params: dict[str, Any] = {}
    if job_id is not None:
        params["JobId"] = job_id
    elif job_ref is not None:
        params["JobRef"] = job_ref
    else:
        return None
    payload = client.get("Job", params)
    if payload.get("Code") not in (0, None):
        return None
    result = payload.get("Result")
    if isinstance(result, list):
        return next((row for row in result if isinstance(row, dict)), None)
    if isinstance(result, dict):
        return result
    return None


def ref_of(job: dict[str, Any]) -> str:
    return str(job.get("Ref") or "").strip()


def job_id_of(job: dict[str, Any]) -> int:
    return int(job.get("JobId") or job.get("id") or 0)


def has_resource_and_plan(job: dict[str, Any]) -> bool:
    resource = normalise(job.get("Resource"))
    planned = parse_datetime(job.get("PlannedStart"))
    return bool(resource and resource not in {"unassigned", "unallocated", "none", "null"} and planned)


def resource_short_name(full_name: str) -> str:
    if " - " in full_name:
        return full_name.split(" - ", 1)[1].strip()
    parts = full_name.split()
    if len(parts) >= 2:
        return " ".join(parts[-2:])
    return full_name.strip()


def confidence_from(parts: list[str]) -> str:
    if "Low" in parts:
        return "Low"
    if "Medium" in parts:
        return "Medium"
    return "High"


def build_stale_recommendation(
    client: BigChangeClient,
    job: dict[str, Any],
    rules: dict[str, Any],
    *,
    site: str,
    site_method: str,
    current_resource_name: str,
    current_resource_active: bool,
) -> Recommendation | tuple[str, str]:
    if is_ppm_job(job):
        return ref_of(job), "PPM stale diary entry requires manual review"

    role_match = determine_role(job)
    if not role_match.role:
        role_from_resource = resource_role(current_resource_name, rules)
        if not role_from_resource:
            return ref_of(job), role_match.reason
        role_match.role = role_from_resource
        role_match.reason = f"Role inferred from current resource '{current_resource_name}'"
        role_match.confidence = "Medium"

    duration, duration_reason, duration_confidence = estimate_duration(job, rules)
    preferred = resource_short_name(current_resource_name) if current_resource_active else None
    resource, slot, warnings = choose_resource(
        client,
        site,
        role_match.role,
        duration,
        rules,
        preferred_resource=preferred,
    )
    if not resource or not slot:
        return ref_of(job), "; ".join(warnings)

    diary = client.resource_diary(resource.resource_id, slot.date, slot.date)
    schedule_jobs = [entry for entry in diary if not is_cancelled_diary_job(entry)]
    blocks = diary_blocks(schedule_jobs, slot.date)
    slot_start = dt.datetime.combine(slot.date, slot.start)
    slot_end = dt.datetime.combine(slot.date, slot.end)
    if slot_has_overlap(blocks, slot_start, slot_end):
        return ref_of(job), "Proposed slot overlaps an existing planned diary booking"

    confidence = confidence_from(["High", role_match.confidence, duration_confidence])
    if not current_resource_active:
        warnings.append(f"Original resource '{current_resource_name}' is inactive; selected another active site resource")

    return Recommendation(
        job_ref=ref_of(job),
        job_id=job_id_of(job),
        site=site,
        site_identification=site_method,
        description=str(job.get("Description") or "")[:500],
        status=str(job.get("Status") or ""),
        flags=str(job.get("CurrentFlag") or "None"),
        required_role=role_match.role,
        proposed_resource=resource.name,
        proposed_resource_id=resource.resource_id,
        proposed_date=slot.date.isoformat(),
        proposed_start=slot.start.strftime("%H:%M"),
        proposed_end=slot.end.strftime("%H:%M"),
        duration_minutes=slot.duration_minutes,
        duration_reason=duration_reason,
        resource_reason=(
            f"Selected {resource.name} for stale diary reschedule. "
            f"Original resource was {current_resource_name}; "
            f"working hours on selected date: "
            f"{resource_working_windows(client, resource.resource_id, slot.date, {}, rules)}"
        ),
        contractor_check="Passed",
        ppm_check="Not a PPM job",
        overlap_check="Passed",
        booking_before=slot.booking_before,
        booking_after=slot.booking_after,
        priority=str(job.get("CurrentFlag") or job.get("Status") or "Routine"),
        target_date=str(job.get("DueDate") or "Not specified"),
        confidence=confidence,
        assumptions=warnings,
    )


def verify_schedule(
    client: BigChangeClient,
    recommendation: Recommendation,
    job_id: int,
) -> tuple[bool, str]:
    expected_start = parse_datetime(f"{recommendation.proposed_date} {recommendation.proposed_start}:00")
    job = fetch_job(client, job_id=job_id)
    if not job:
        return False, "Job could not be fetched after scheduling"
    planned = parse_datetime(job.get("PlannedStart"))
    if not planned:
        return False, "Job has no PlannedStart after scheduling"
    if expected_start and planned != expected_start:
        return False, f"Job PlannedStart is {planned}, expected {expected_start}"
    if not normalise(job.get("Resource")):
        return False, "Job has PlannedStart but no Resource after scheduling"

    diary = client.resource_diary(
        recommendation.proposed_resource_id,
        dt.date.fromisoformat(recommendation.proposed_date),
        dt.date.fromisoformat(recommendation.proposed_date),
    )
    for entry in diary:
        if job_id_of(entry) == job_id or ref_of(entry) == recommendation.job_ref:
            return True, "Schedule verified on job and resource diary"
    return False, "Job does not appear on intended resource diary after scheduling"


def apply_recommendation(
    client: BigChangeClient,
    recommendation: Recommendation,
    *,
    mode: str,
    original_date: str | None = None,
) -> dict[str, Any]:
    schedule_dt = f"{recommendation.proposed_date} {recommendation.proposed_start}:00"
    client.schedule_job(recommendation.job_id, recommendation.proposed_resource_id, schedule_dt, recommendation.duration_minutes)
    verified, verify_message = verify_schedule(client, recommendation, recommendation.job_id)
    note = None
    if not verified:
        client.schedule_job(recommendation.job_id, recommendation.proposed_resource_id, schedule_dt, recommendation.duration_minutes)
        verified, second_message = verify_schedule(client, recommendation, recommendation.job_id)
        note = f"Initial verification failed: {verify_message}; reapplied once: {second_message}"
    if not verified:
        raise RuntimeError(note or verify_message)

    record: dict[str, Any] = {
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
    }
    if original_date:
        record["original_date"] = original_date
    if note:
        record["note"] = note
    append_audit(record)
    return record


def active_btr_resources(resources: list[dict[str, Any]], rules: dict[str, Any]) -> list[dict[str, Any]]:
    active: list[dict[str, Any]] = []
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
        active.append(resource)
    return active


def discover_stale_diary_jobs(
    client: BigChangeClient,
    rules: dict[str, Any],
    resources: list[dict[str, Any]],
    audited_refs: set[str],
    lookback_days: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    today = dt.date.today()
    start = today - dt.timedelta(days=lookback_days)
    end = today - dt.timedelta(days=1)
    if end < start:
        return [], []

    candidates: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for resource in active_btr_resources(resources, rules):
        resource_id = int(resource["id"])
        resource_name = str(resource.get("label") or "")
        site = resource_site(resource_name, rules)
        if not site:
            continue
        for job in client.resource_diary(resource_id, start, end):
            ref = ref_of(job)
            if not ref or ref in seen:
                continue
            seen.add(ref)
            planned = parse_datetime(job.get("PlannedStart"))
            status_id = as_int(job.get("StatusId"))
            if not planned or planned.date() >= today:
                continue
            if status_id in CLOSED_STATUS_IDS or is_cancelled_diary_job(job):
                continue
            if ref in audited_refs:
                skipped.append({"ref": ref, "reason": "already present in allocation audit"})
                continue
            if is_ppm_job(job):
                skipped.append({"ref": ref, "reason": "PPM stale diary entry requires manual review"})
                continue
            candidates.append(
                {
                    "job": job,
                    "resource_name": resource_name,
                    "resource_active": True,
                    "site": site,
                    "site_method": f"Site inferred from current resource '{resource_name}'",
                    "original_date": planned.strftime("%Y-%m-%d"),
                }
            )
    return candidates, skipped


def run_stale_reschedules(
    client: BigChangeClient,
    rules: dict[str, Any],
    resources: list[dict[str, Any]],
    audited_refs: set[str],
    lookback_days: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    applied: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    candidates, skipped = discover_stale_diary_jobs(client, rules, resources, audited_refs, lookback_days)
    for item in candidates:
        job = item["job"]
        ref = ref_of(job)
        try:
            full_job = fetch_job(client, job_id=job_id_of(job)) or job
            result = build_stale_recommendation(
                client,
                full_job,
                rules,
                site=item["site"],
                site_method=item["site_method"],
                current_resource_name=item["resource_name"],
                current_resource_active=item["resource_active"],
            )
            if isinstance(result, tuple):
                skipped.append({"ref": ref, "reason": result[1]})
                continue
            record = apply_recommendation(
                client,
                result,
                mode="daily_incomplete_reschedule",
                original_date=item["original_date"],
            )
            applied.append(record)
            audited_refs.add(ref)
        except Exception as exc:  # noqa: BLE001 - continue daily batch after one job fails
            failed.append({"ref": ref, "error": str(exc)})
    return applied, skipped, failed


def run_unallocated_allocations(
    client: BigChangeClient,
    rules: dict[str, Any],
    audited_refs: set[str],
    lookback_days: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    for job in fetch_unallocated_jobs(client, lookback_days=lookback_days):
        ref = ref_of(job)
        site_match = identify_site(job, rules)
        if not site_match:
            continue

        excluded, exclusion_reason = contractor_exclusion(job, rules)
        if excluded:
            skipped.append({"ref": ref, "reason": exclusion_reason})
            continue

        ppm_allowed, ppm_reason = ppm_tech_diary_review(job, rules)
        if not ppm_allowed:
            skipped.append({"ref": ref, "reason": ppm_reason})
            continue

        if ref in audited_refs and has_resource_and_plan(job):
            skipped.append({"ref": ref, "reason": "already present in allocation audit"})
            continue

        try:
            result = build_recommendation(client, job, rules)
            if isinstance(result, tuple):
                skipped.append({"ref": ref, "reason": result[1]})
                continue
            mode = f"daily_allocate_{result.confidence.lower()}"
            record = apply_recommendation(client, result, mode=mode)
            applied.append(record)
            audited_refs.add(ref)
        except Exception as exc:  # noqa: BLE001 - continue daily batch after one job fails
            failed.append({"ref": ref, "error": str(exc)})
    return applied, skipped, failed


def workload_warnings(client: BigChangeClient, applied: list[dict[str, Any]]) -> list[dict[str, Any]]:
    warnings: list[dict[str, Any]] = []
    seen: set[tuple[int, str]] = set()
    for record in applied:
        resource_id = int(record["resource_id"])
        date_text = str(record["scheduled_date"])
        key = (resource_id, date_text)
        if key in seen:
            continue
        seen.add(key)
        day = dt.date.fromisoformat(date_text)
        diary = client.resource_diary(resource_id, day, day)
        jobs = [
            job
            for job in diary
            if not is_cancelled_diary_job(job) and as_int(job.get("StatusId")) not in CLOSED_STATUS_IDS
        ]
        if len(jobs) >= 4:
            warnings.append(
                {
                    "resource": record["resource"],
                    "date": date_text,
                    "job_count": len(jobs),
                }
            )
    return warnings


def escape_cell(value: Any) -> str:
    return str(value if value is not None else "").replace("|", "\\|").replace("\n", " ")


def markdown_table(headers: list[str], rows: list[list[Any]]) -> str:
    if not rows:
        return "_None_"
    output = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    for row in rows:
        output.append("| " + " | ".join(escape_cell(item) for item in row) + " |")
    return "\n".join(output)


def write_summary(
    path: Path,
    *,
    run_timestamp: str,
    applied: list[dict[str, Any]],
    skipped: list[dict[str, Any]],
    failed: list[dict[str, Any]],
    warnings: list[dict[str, Any]],
    setup_error: str | None = None,
) -> None:
    skipped_by_reason = Counter(str(item.get("reason") or "unspecified") for item in skipped)
    manual_review = [
        item
        for item in skipped
        if any(
            token in str(item.get("reason") or "").lower()
            for token in ("ppm", "contractor", "aquilo", "baltic", "low confidence", "no suitable resource")
        )
    ]

    applied_rows = [
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
    ]
    skipped_rows = [[item.get("ref"), item.get("reason")] for item in skipped]
    failed_rows = [[item.get("ref"), item.get("error")] for item in failed]
    warning_rows = [[item.get("resource"), item.get("date"), item.get("job_count")] for item in warnings]
    manual_rows = [[item.get("ref"), item.get("reason")] for item in manual_review]

    lines = [
        f"# BTR Daily Run - {path.stem.removeprefix('btr-daily-run-')}",
        "",
        f"- Run timestamp: {run_timestamp}",
        f"- Applied: {len(applied)}",
        f"- Failed: {len(failed)}",
        f"- Skipped: {len(skipped)}",
    ]
    if setup_error:
        lines.append(f"- Setup/API connectivity error: {setup_error}")
    lines.extend(["", "## Skipped by reason"])
    if skipped_by_reason:
        lines.extend(f"- {reason}: {count}" for reason, count in sorted(skipped_by_reason.items()))
    else:
        lines.append("_None_")
    lines.extend(
        [
            "",
            "## Applied jobs",
            markdown_table(["Ref", "Site", "Resource", "Date", "Start-End", "Confidence", "Mode"], applied_rows),
            "",
            "## Skipped jobs",
            markdown_table(["Ref", "Reason"], skipped_rows),
            "",
            "## Failed jobs",
            markdown_table(["Ref", "Error"], failed_rows),
            "",
            "## Workload warnings",
            markdown_table(["Resource", "Date", "Open diary jobs"], warning_rows),
            "",
            "## Manual review",
            markdown_table(["Ref", "Reason"], manual_rows),
            "",
        ]
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the daily BTR allocation workflow")
    parser.add_argument("--lookback-days", type=int, default=14)
    parser.add_argument("--summary-date", default=dt.date.today().isoformat())
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    run_timestamp = utc_now().isoformat()
    summary_path = SUMMARY_DIR / f"btr-daily-run-{args.summary_date}.md"
    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    setup_error: str | None = None

    try:
        rules = load_rules()
        audited_refs = load_audited_refs()
        client = BigChangeClient()
        resources = client.resources()
    except Exception as exc:  # noqa: BLE001 - still produce the required daily summary
        setup_error = str(exc)
        failed.append({"ref": "SETUP", "error": setup_error})
        write_summary(
            summary_path,
            run_timestamp=run_timestamp,
            applied=applied,
            skipped=skipped,
            failed=failed,
            warnings=warnings,
            setup_error=setup_error,
        )
        print(json.dumps({"summary": str(summary_path), "applied": 0, "failed": 1, "skipped": 0}, indent=2))
        return 1

    stale_applied, stale_skipped, stale_failed = run_stale_reschedules(
        client,
        rules,
        resources,
        audited_refs,
        args.lookback_days,
    )
    applied.extend(stale_applied)
    skipped.extend(stale_skipped)
    failed.extend(stale_failed)

    allocation_applied, allocation_skipped, allocation_failed = run_unallocated_allocations(
        client,
        rules,
        audited_refs,
        args.lookback_days,
    )
    applied.extend(allocation_applied)
    skipped.extend(allocation_skipped)
    failed.extend(allocation_failed)

    try:
        warnings = workload_warnings(client, applied)
    except Exception as exc:  # noqa: BLE001 - summary should still be written
        failed.append({"ref": "WORKLOAD_CHECK", "error": str(exc)})

    write_summary(
        summary_path,
        run_timestamp=run_timestamp,
        applied=applied,
        skipped=skipped,
        failed=failed,
        warnings=warnings,
    )
    print(
        json.dumps(
            {
                "summary": str(summary_path),
                "applied": len(applied),
                "failed": len(failed),
                "skipped": len(skipped),
            },
            indent=2,
        )
    )
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
