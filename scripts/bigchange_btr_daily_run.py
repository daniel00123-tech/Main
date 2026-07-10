#!/usr/bin/env python3
"""Run the daily BTR allocation workflow against the BigChange TEST environment."""

from __future__ import annotations

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
    ConfigError,
    Recommendation,
    SlotProposal,
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
    next_working_day,
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
REQUIRED_ENV = (
    "BIGCHANGE_BASE_URL",
    "BIGCHANGE_API_KEY",
    "BIGCHANGE_USERNAME",
    "BIGCHANGE_PASSWORD",
)


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def today() -> dt.date:
    return dt.date.today()


def load_audit_records() -> list[dict[str, Any]]:
    if not AUDIT_PATH.exists():
        return []
    records: list[dict[str, Any]] = []
    for line in AUDIT_PATH.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(record, dict):
            records.append(record)
    return records


def append_audit(record: dict[str, Any]) -> None:
    AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with AUDIT_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")


def env_error() -> str | None:
    missing = [name for name in REQUIRED_ENV if not os.environ.get(name)]
    if missing:
        return f"Missing required BigChange environment variables: {', '.join(missing)}"
    auth_mode = os.environ.get("BIGCHANGE_AUTH_MODE", "api_key").strip().lower()
    if auth_mode != "api_key":
        return f"Unsupported BIGCHANGE_AUTH_MODE '{auth_mode}' for BTR daily automation"
    return None


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
        return result[0] if isinstance(result[0], dict) else None
    return result if isinstance(result, dict) else None


def job_ref(job: dict[str, Any]) -> str:
    return str(job.get("Ref") or "").strip()


def planned_date(job: dict[str, Any]) -> dt.datetime | None:
    return parse_datetime(job.get("PlannedStart"))


def status_is_open(job: dict[str, Any]) -> bool:
    if is_cancelled_diary_job(job):
        return False
    status_id = as_int(job.get("StatusId"))
    if status_id in CLOSED_STATUS_IDS:
        return False
    status = normalise(job.get("Status"))
    return status not in {"completed", "complete", "cancelled", "deleted", "rejected"}


def resource_label(resource: dict[str, Any]) -> str:
    return str(resource.get("label") or "").strip()


def resource_map(resources: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    mapped: dict[int, dict[str, Any]] = {}
    for resource in resources:
        resource_id = as_int(resource.get("id"))
        if resource_id is not None:
            mapped[resource_id] = resource
    return mapped


def btr_resource_rows(resources: list[dict[str, Any]], rules: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for resource in resources:
        name = resource_label(resource)
        site = resource_site(name, rules)
        role = resource_role(name, rules)
        if not site or not role:
            continue
        rows.append(
            {
                "resource": resource,
                "resource_id": int(resource["id"]),
                "name": name,
                "site": site,
                "role": role,
                "active": resource_is_active_for_jobwatch(resource),
                "excluded": resource_is_excluded(name, rules),
            }
        )
    return rows


def slot_for_resource(
    client: BigChangeClient,
    resource_id: int,
    duration_minutes: int,
    rules: dict[str, Any],
    *,
    search_days: int = SEARCH_DAYS,
) -> SlotProposal | None:
    start_day = next_working_day(today())
    end_day = start_day + dt.timedelta(days=search_days)
    diary = client.resource_diary(resource_id, start_day, end_day)
    schedule_jobs = [job for job in diary if not is_cancelled_diary_job(job)]
    working_hours_cache: dict[int, list[dict[str, Any]]] = {}

    for offset in range(search_days + 1):
        day = start_day + dt.timedelta(days=offset)
        if day.weekday() >= 5:
            continue
        windows = resource_working_windows(client, resource_id, day, working_hours_cache, rules)
        blocks = diary_blocks(schedule_jobs, day)
        slot = find_slot(blocks, day, duration_minutes, windows)
        if not slot:
            continue
        slot_start = dt.datetime.combine(day, slot.start)
        slot_end = dt.datetime.combine(day, slot.end)
        if slot_has_overlap(blocks, slot_start, slot_end):
            continue
        return slot
    return None


def recommendation_from_existing_resource(
    client: BigChangeClient,
    job: dict[str, Any],
    resource: dict[str, Any],
    rules: dict[str, Any],
    *,
    mode_confidence: str = "High",
) -> Recommendation | tuple[str, str]:
    name = resource_label(resource)
    site = resource_site(name, rules)
    role = resource_role(name, rules)
    if not site or not role:
        site_match = identify_site(job, rules)
        role_match = determine_role(job)
        site = site_match.site if site_match else None
        role = role_match.role
    if not site or not role:
        return job_ref(job), "Site or role could not be inferred from assigned resource"

    excluded, exclusion_reason = contractor_exclusion(job, rules)
    if excluded:
        return job_ref(job), exclusion_reason

    ppm_allowed, ppm_reason = ppm_tech_diary_review(job, rules)
    if not ppm_allowed:
        return job_ref(job), ppm_reason

    duration, duration_reason, duration_confidence = estimate_duration(job, rules)
    slot = slot_for_resource(client, int(resource["id"]), duration, rules)
    if not slot:
        return job_ref(job), "No suitable diary slot found for current assigned resource"

    confidence = "Low" if duration_confidence == "Low" else mode_confidence
    return Recommendation(
        job_ref=job_ref(job),
        job_id=int(job.get("JobId") or 0),
        site=site,
        site_identification=f"Inferred from assigned resource '{name}'",
        description=str(job.get("Description") or "")[:500],
        status=str(job.get("Status") or ""),
        flags=str(job.get("CurrentFlag") or "None"),
        required_role=role,
        proposed_resource=name,
        proposed_resource_id=int(resource["id"]),
        proposed_date=slot.date.isoformat(),
        proposed_start=slot.start.strftime("%H:%M"),
        proposed_end=slot.end.strftime("%H:%M"),
        duration_minutes=slot.duration_minutes,
        duration_reason=duration_reason,
        resource_reason=f"Kept same active assigned resource '{name}' and moved to next non-overlapping slot",
        contractor_check="Passed",
        ppm_check=ppm_reason,
        overlap_check="Passed",
        booking_before=slot.booking_before,
        booking_after=slot.booking_after,
        priority=str(job.get("CurrentFlag") or job.get("Status") or "Routine"),
        target_date=str(job.get("DueDate") or "Not specified"),
        confidence=confidence,
        assumptions=[],
    )


def make_audit_record(recommendation: Recommendation, *, mode: str, original_date: str | None = None) -> dict[str, Any]:
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
    return record


def schedule_and_verify(
    client: BigChangeClient,
    recommendation: Recommendation,
    *,
    mode: str,
    original_date: str | None = None,
) -> tuple[dict[str, Any] | None, str | None]:
    schedule_dt = f"{recommendation.proposed_date} {recommendation.proposed_start}:00"
    client.schedule_job(recommendation.job_id, recommendation.proposed_resource_id, schedule_dt, recommendation.duration_minutes)

    refreshed = fetch_job(client, job_id=recommendation.job_id)
    if not refreshed:
        return None, "Schedule API returned success but job could not be re-fetched for verification"

    planned = planned_date(refreshed)
    resource_text = normalise(refreshed.get("Resource"))
    if not planned or planned.strftime("%Y-%m-%d %H:%M") != f"{recommendation.proposed_date} {recommendation.proposed_start}":
        return None, "Schedule verification failed: PlannedStart did not match intended slot"
    if not resource_text or resource_text in {"unassigned", "unallocated", "none", "null"}:
        return None, "Schedule verification failed: Resource was empty after scheduling"

    diary = client.resource_diary(recommendation.proposed_resource_id, planned.date(), planned.date())
    found = any(job_ref(entry) == recommendation.job_ref for entry in diary)
    if not found:
        return None, "Schedule verification failed: job not found on intended resource diary"

    record = make_audit_record(recommendation, mode=mode, original_date=original_date)
    append_audit(record)
    return record, None


def discover_stale_diary_jobs(
    client: BigChangeClient,
    resources: list[dict[str, Any]],
    rules: dict[str, Any],
    applied_refs: set[str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    start = today() - dt.timedelta(days=LOOKBACK_DAYS)
    end = today() - dt.timedelta(days=1)
    if end < start:
        return [], []

    candidates: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    seen: set[str] = set()
    rows = btr_resource_rows(resources, rules)
    resources_by_id = resource_map(resources)

    for row in rows:
        resource = row["resource"]
        resource_id = row["resource_id"]
        if row["excluded"]:
            continue
        try:
            diary = client.resource_diary(resource_id, start, end)
        except Exception as exc:
            skipped.append({"ref": f"resource:{resource_id}", "reason": f"Failed to read diary for {row['name']}: {exc}"})
            continue
        for job in diary:
            ref = job_ref(job)
            if not ref or ref in seen:
                continue
            seen.add(ref)
            planned = planned_date(job)
            if not planned or planned.date() >= today():
                continue
            if not status_is_open(job):
                continue
            if ref in applied_refs:
                skipped.append({"ref": ref, "reason": "Already actioned in allocation audit"})
                continue

            assigned_resource = resources_by_id.get(resource_id, resource)
            site = resource_site(resource_label(assigned_resource), rules) or (identify_site(job, rules).site if identify_site(job, rules) else None)
            if not site:
                skipped.append({"ref": ref, "reason": "BTR site could not be identified from job or assigned resource"})
                continue
            if is_ppm_job(job):
                skipped.append({"ref": ref, "reason": "PPM stale diary entry requires manual review only"})
                continue
            excluded, exclusion_reason = contractor_exclusion(job, rules)
            if excluded:
                skipped.append({"ref": ref, "reason": exclusion_reason})
                continue

            candidates.append(
                {
                    "job": job,
                    "resource": assigned_resource,
                    "planned": planned.strftime("%Y-%m-%d %H:%M:%S"),
                    "resource_active": row["active"],
                }
            )
    candidates.sort(key=lambda item: (item["planned"], job_ref(item["job"])))
    return candidates, skipped


def process_stale_candidate(
    client: BigChangeClient,
    item: dict[str, Any],
    rules: dict[str, Any],
) -> tuple[dict[str, Any] | None, dict[str, Any] | None, dict[str, Any] | None]:
    job = item["job"]
    ref = job_ref(job)
    resource = item["resource"]
    original_date = item["planned"]

    try:
        if not item["resource_active"]:
            active_rec = build_recommendation(client, job, rules)
            if isinstance(active_rec, tuple):
                return None, {"ref": ref, "reason": f"Assigned resource inactive; {active_rec[1]}"}, None
            recommendation = active_rec
        else:
            result = recommendation_from_existing_resource(client, job, resource, rules)
            if isinstance(result, tuple):
                return None, {"ref": ref, "reason": result[1]}, None
            recommendation = result

        record, error = schedule_and_verify(
            client,
            recommendation,
            mode="daily_incomplete_reschedule",
            original_date=original_date,
        )
        if error:
            return None, None, {"ref": ref, "error": error}
        return {"ref": ref, "status": "applied", **(record or {})}, None, None
    except Exception as exc:
        return None, None, {"ref": ref, "error": str(exc)}


def process_unallocated_job(
    client: BigChangeClient,
    job: dict[str, Any],
    rules: dict[str, Any],
) -> tuple[dict[str, Any] | None, dict[str, Any] | None, dict[str, Any] | None]:
    ref = job_ref(job)
    try:
        excluded, exclusion_reason = contractor_exclusion(job, rules)
        if excluded:
            return None, {"ref": ref, "reason": exclusion_reason}, None

        ppm_allowed, ppm_reason = ppm_tech_diary_review(job, rules)
        if not ppm_allowed:
            return None, {"ref": ref, "reason": ppm_reason}, None

        site_match = identify_site(job, rules)
        if not site_match:
            return None, {"ref": ref, "reason": "Site could not be identified confidently"}, None

        result = build_recommendation(client, job, rules)
        if isinstance(result, tuple):
            return None, {"ref": ref, "reason": result[1]}, None

        mode = f"daily_allocate_{result.confidence.lower()}"
        record, error = schedule_and_verify(client, result, mode=mode)
        if error:
            return None, None, {"ref": ref, "error": error}
        applied = {"ref": ref, "status": "applied", **(record or {})}
        if result.confidence == "Low":
            applied["manual_review"] = "Low-confidence allocation; review recommended"
        return applied, None, None
    except Exception as exc:
        return None, None, {"ref": ref, "error": str(exc)}


def workload_warnings(client: BigChangeClient, applied: list[dict[str, Any]]) -> list[str]:
    warnings: list[str] = []
    by_resource_day: set[tuple[int, dt.date, str]] = set()
    for record in applied:
        resource_id = as_int(record.get("resource_id"))
        date_text = record.get("scheduled_date")
        if resource_id is None or not date_text:
            continue
        try:
            day = dt.date.fromisoformat(str(date_text))
        except ValueError:
            continue
        by_resource_day.add((resource_id, day, str(record.get("resource") or resource_id)))

    for resource_id, day, name in sorted(by_resource_day, key=lambda item: (item[2], item[1])):
        diary = client.resource_diary(resource_id, day, day)
        open_jobs = [job for job in diary if not is_cancelled_diary_job(job) and as_int(job.get("StatusId")) not in CLOSED_STATUS_IDS]
        if len(open_jobs) >= 4:
            warnings.append(f"{name} has {len(open_jobs)} open planned jobs on {day.isoformat()}")
    return warnings


def markdown_table(headers: list[str], rows: list[list[Any]]) -> str:
    if not rows:
        return "_None_"
    output = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    for row in rows:
        output.append("| " + " | ".join(str(cell).replace("\n", " ") for cell in row) + " |")
    return "\n".join(output)


def write_summary(
    *,
    run_started: dt.datetime,
    applied: list[dict[str, Any]],
    skipped: list[dict[str, Any]],
    failed: list[dict[str, Any]],
    workload: list[str],
    setup_error: str | None = None,
    resources_count: int | None = None,
) -> Path:
    summary_path = SUMMARY_DIR / f"btr-daily-run-{today().isoformat()}.md"
    skipped_by_reason = Counter(str(item.get("reason") or "unspecified") for item in skipped)
    manual_review = []
    for item in skipped:
        reason = str(item.get("reason") or "")
        if any(token in reason.lower() for token in ("ppm", "contractor", "aquilo", "baltic", "no suitable resource")):
            manual_review.append([item.get("ref", ""), reason])
    for item in applied:
        if item.get("confidence") == "Low" or item.get("manual_review"):
            manual_review.append([item.get("ref", ""), item.get("manual_review") or "Low-confidence allocation; review recommended"])

    lines = [
        f"# BTR Daily Run - {today().isoformat()}",
        "",
        f"- Run timestamp: {run_started.isoformat()}",
        f"- BigChange Resources connectivity: {'failed' if setup_error else 'passed'}"
        + (f" ({resources_count} resources returned)" if resources_count is not None else ""),
        f"- Lookback window: {LOOKBACK_DAYS} days",
        "",
        "## Counts",
        "",
        markdown_table(
            ["Applied", "Failed", "Skipped"],
            [[len(applied), len(failed), len(skipped)]],
        ),
        "",
        "### Skipped by reason",
        "",
        markdown_table(["Reason", "Count"], [[reason, count] for reason, count in skipped_by_reason.most_common()]),
        "",
        "## Applied jobs",
        "",
        markdown_table(
            ["Ref", "Site", "Resource", "Date", "Start-End", "Confidence", "Mode"],
            [
                [
                    item.get("job_ref") or item.get("ref"),
                    item.get("site", ""),
                    item.get("resource", ""),
                    item.get("scheduled_date", ""),
                    f"{item.get('start', '')}-{item.get('end', '')}",
                    item.get("confidence", ""),
                    item.get("mode", ""),
                ]
                for item in applied
            ],
        ),
        "",
        "## Skipped jobs",
        "",
        markdown_table(["Ref", "Reason"], [[item.get("ref", ""), item.get("reason", "")] for item in skipped]),
        "",
        "## Failed jobs",
        "",
        markdown_table(["Ref", "Error"], [[item.get("ref", ""), item.get("error", "")] for item in failed]),
        "",
        "## Workload warnings",
        "",
        "\n".join(f"- {item}" for item in workload) if workload else "_None_",
        "",
        "## Manual review",
        "",
        markdown_table(["Ref", "Reason"], manual_review),
        "",
    ]
    if setup_error:
        lines.extend(
            [
                "## Setup failure",
                "",
                setup_error,
                "",
                "No BigChange writes were attempted because setup/connectivity did not complete.",
                "",
            ]
        )
    summary_path.write_text("\n".join(lines), encoding="utf-8")
    return summary_path


def main() -> int:
    run_started = utc_now()
    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []

    setup_error = env_error()
    if setup_error:
        failed.append({"ref": "SETUP", "error": setup_error})
        summary_path = write_summary(
            run_started=run_started,
            applied=applied,
            skipped=skipped,
            failed=failed,
            workload=[],
            setup_error=setup_error,
        )
        print(json.dumps({"summary": str(summary_path), "applied": 0, "failed": 1, "skipped": 0}, indent=2))
        return 1

    try:
        rules = load_rules()
        audit_records = load_audit_records()
        applied_refs = {str(record.get("job_ref") or "") for record in audit_records if record.get("job_ref")}
        client = BigChangeClient()
        resources = client.resources()
    except (ConfigError, Exception) as exc:
        setup_error = f"BigChange setup/connectivity failed: {exc}"
        failed.append({"ref": "SETUP", "error": setup_error})
        summary_path = write_summary(
            run_started=run_started,
            applied=applied,
            skipped=skipped,
            failed=failed,
            workload=[],
            setup_error=setup_error,
        )
        print(json.dumps({"summary": str(summary_path), "applied": 0, "failed": 1, "skipped": 0}, indent=2))
        return 1

    stale_candidates, stale_skipped = discover_stale_diary_jobs(client, resources, rules, applied_refs)
    skipped.extend(stale_skipped)
    for item in stale_candidates:
        applied_item, skipped_item, failed_item = process_stale_candidate(client, item, rules)
        if applied_item:
            applied.append(applied_item)
            applied_refs.add(str(applied_item.get("job_ref") or applied_item.get("ref") or ""))
        if skipped_item:
            skipped.append(skipped_item)
        if failed_item:
            failed.append(failed_item)

    try:
        unallocated = fetch_unallocated_jobs(client, lookback_days=LOOKBACK_DAYS)
    except Exception as exc:
        failed.append({"ref": "UNALLOCATED_FETCH", "error": str(exc)})
        unallocated = []

    for job in sorted(unallocated, key=job_ref):
        site_match = identify_site(job, rules)
        if not site_match:
            continue
        applied_item, skipped_item, failed_item = process_unallocated_job(client, job, rules)
        if applied_item:
            applied.append(applied_item)
            applied_refs.add(str(applied_item.get("job_ref") or applied_item.get("ref") or ""))
        if skipped_item:
            skipped.append(skipped_item)
        if failed_item:
            failed.append(failed_item)

    try:
        workload = workload_warnings(client, applied)
    except Exception as exc:
        workload = [f"Unable to complete workload sanity check: {exc}"]

    summary_path = write_summary(
        run_started=run_started,
        applied=applied,
        skipped=skipped,
        failed=failed,
        workload=workload,
        resources_count=len(resources),
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
