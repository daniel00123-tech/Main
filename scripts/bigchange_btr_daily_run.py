#!/usr/bin/env python3
"""Daily Build-to-Rent allocation runner for the BigChange TEST environment."""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import os
import sys
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
    identify_site,
    is_cancelled_diary_job,
    is_ppm_job,
    is_unallocated,
    load_rules,
    normalise,
    parse_datetime,
    ppm_tech_diary_review,
    resource_is_active_for_jobwatch,
    resource_is_excluded,
    resource_role,
    resource_site,
    slot_has_overlap,
)

AUDIT_PATH = ROOT / "automation-memory/btr-allocation-audit.jsonl"
DAILY_SUMMARY_DIR = ROOT / "automation-memory"
BALTIC_YARD_SITE = "Baltic Yard"


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


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
    result = payload.get("Result")
    if isinstance(result, list):
        return next((item for item in result if isinstance(item, dict)), None)
    if isinstance(result, dict):
        return result
    return None


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


def resource_short_name(full_name: str) -> str:
    if " - " in full_name:
        return full_name.split(" - ", 1)[1].strip()
    parts = full_name.split()
    if len(parts) >= 2:
        return " ".join(parts[-2:])
    return full_name.strip()


def find_resource_by_name(resources: list[dict[str, Any]], name: str) -> dict[str, Any] | None:
    wanted = normalise(name)
    if not wanted:
        return None
    for resource in resources:
        label = normalise(resource.get("label"))
        if label == wanted:
            return resource
    short = normalise(resource_short_name(name))
    for resource in resources:
        label = normalise(resource.get("label"))
        if wanted in label or (short and short in label):
            return resource
    return None


def btr_site_for_diary_job(job: dict[str, Any], rules: dict[str, Any]) -> tuple[str | None, str]:
    resource_name = str(job.get("Resource") or "")
    site_from_resource = resource_site(resource_name, rules)
    if site_from_resource:
        return site_from_resource, f"Matched assigned resource site from '{resource_name}'"
    site_match = identify_site(job, rules)
    if site_match:
        return site_match.site, site_match.method
    return None, "No BTR site keyword found in job or assigned resource"


def job_is_open(job: dict[str, Any]) -> bool:
    if is_cancelled_diary_job(job):
        return False
    status_id = as_int(job.get("StatusId"))
    return status_id not in CLOSED_STATUS_IDS


def fetch_incomplete_diary_jobs(
    client: BigChangeClient,
    rules: dict[str, Any],
    *,
    run_date: dt.date,
    lookback_days: int,
) -> list[dict[str, Any]]:
    start = run_date - dt.timedelta(days=lookback_days)
    rows = client.jobs_list(
        {
            "Start": start.isoformat(),
            "End": run_date.isoformat(),
            "DateOptionId": 0,
            "Allocated": 1,
            "ExcludeNullPlannedDates": 1,
            "includeExtra": 1,
        }
    )
    candidates: list[dict[str, Any]] = []
    for job in rows:
        planned = parse_datetime(job.get("PlannedStart"))
        if not planned or planned.date() >= run_date:
            continue
        if not job_is_open(job):
            continue
        site, method = btr_site_for_diary_job(job, rules)
        if not site:
            continue
        copied = dict(job)
        copied["_btr_site"] = site
        copied["_site_method"] = method
        candidates.append(copied)
    return candidates


def fetch_recent_unallocated_jobs(client: BigChangeClient, *, run_date: dt.date, lookback_days: int) -> list[dict[str, Any]]:
    start = run_date - dt.timedelta(days=lookback_days)
    end = run_date + dt.timedelta(days=1)
    rows = client.jobs_list(
        {
            "Start": start.isoformat(),
            "End": end.isoformat(),
            "DateOptionId": 2,
            "Unallocated": 1,
            "includeExtra": 1,
        }
    )
    return [job for job in rows if is_unallocated(job)]


def verify_schedule(
    client: BigChangeClient,
    *,
    job_id: int,
    job_ref: str,
    resource_id: int,
    scheduled_date: str,
    start: str,
) -> tuple[bool, str]:
    planned_start = parse_datetime(f"{scheduled_date} {start}:00")
    latest = fetch_job(client, job_id=job_id)
    latest_planned = parse_datetime(latest.get("PlannedStart")) if latest else None
    diary = client.resource_diary(resource_id, planned_start.date(), planned_start.date()) if planned_start else []
    in_diary = any(
        as_int(entry.get("JobId")) == job_id or str(entry.get("Ref") or "") == job_ref
        for entry in diary
    )
    if latest_planned and planned_start and latest_planned == planned_start and in_diary:
        return True, "Verified planned start and resource diary entry"
    if latest_planned and planned_start and latest_planned == planned_start:
        return False, "PlannedStart was set but job was not found on intended resource diary"
    return False, "PlannedStart was not set to the intended slot"


def recommendation_audit_record(recommendation: Recommendation, *, mode: str, original_date: str | None = None) -> dict[str, Any]:
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


def apply_recommendation(
    client: BigChangeClient,
    recommendation: Recommendation,
    *,
    mode: str,
    original_date: str | None = None,
    dry_run: bool,
) -> dict[str, Any]:
    schedule_dt = f"{recommendation.proposed_date} {recommendation.proposed_start}:00"
    record = recommendation_audit_record(recommendation, mode=mode, original_date=original_date)
    if dry_run:
        record["dry_run"] = True
        return record

    client.schedule_job(
        recommendation.job_id,
        recommendation.proposed_resource_id,
        schedule_dt,
        recommendation.duration_minutes,
    )
    ok, message = verify_schedule(
        client,
        job_id=recommendation.job_id,
        job_ref=recommendation.job_ref,
        resource_id=recommendation.proposed_resource_id,
        scheduled_date=recommendation.proposed_date,
        start=recommendation.proposed_start,
    )
    if not ok:
        client.schedule_job(
            recommendation.job_id,
            recommendation.proposed_resource_id,
            schedule_dt,
            recommendation.duration_minutes,
        )
        ok, message = verify_schedule(
            client,
            job_id=recommendation.job_id,
            job_ref=recommendation.job_ref,
            resource_id=recommendation.proposed_resource_id,
            scheduled_date=recommendation.proposed_date,
            start=recommendation.proposed_start,
        )
    record["verification"] = message
    if not ok:
        raise RuntimeError(f"Schedule verification failed after retry: {message}")
    append_audit(record)
    return record


def build_reschedule_recommendation(
    client: BigChangeClient,
    job: dict[str, Any],
    rules: dict[str, Any],
    resources: list[dict[str, Any]],
) -> Recommendation | tuple[str, str]:
    site = str(job.get("_btr_site") or "")
    if not site:
        return str(job.get("Ref") or ""), "BTR site could not be identified"

    assigned_name = str(job.get("Resource") or "")
    assigned_resource = find_resource_by_name(resources, assigned_name)
    assigned_role = resource_role(assigned_name, rules)
    role_match = determine_role(job)
    required_role = role_match.role or assigned_role or "Tech"
    if required_role != "HK" and assigned_role in {"Tech", "CT"}:
        required_role = assigned_role

    duration, duration_reason, duration_confidence = estimate_duration(job, rules)
    preferred_resource: str | None = assigned_name
    inactive_note = ""
    if assigned_resource and not resource_is_active_for_jobwatch(assigned_resource):
        preferred_resource = None
        inactive_note = f"Assigned resource '{assigned_name}' is inactive; selected another active site resource. "
    elif assigned_resource and resource_is_excluded(str(assigned_resource.get("label") or ""), rules):
        return str(job.get("Ref") or ""), f"Assigned resource '{assigned_name}' is excluded by resource rules"
    elif not assigned_resource:
        preferred_resource = assigned_name or None

    resource, slot, warnings = choose_resource(
        client,
        site,
        required_role,
        duration,
        rules,
        preferred_resource=preferred_resource,
    )
    if not resource or not slot:
        return str(job.get("Ref") or ""), "; ".join(warnings)

    diary = client.resource_diary(resource.resource_id, slot.date, slot.date)
    blocks = diary_blocks([entry for entry in diary if not is_cancelled_diary_job(entry)], slot.date)
    slot_start = dt.datetime.combine(slot.date, slot.start)
    slot_end = dt.datetime.combine(slot.date, slot.end)
    if slot_has_overlap(blocks, slot_start, slot_end):
        return str(job.get("Ref") or ""), "Proposed reschedule slot overlaps an existing planned booking"

    if inactive_note:
        warnings.append(inactive_note.strip())
    return Recommendation(
        job_ref=str(job.get("Ref") or ""),
        job_id=int(job.get("JobId") or 0),
        site=site,
        site_identification=str(job.get("_site_method") or "Diary resource site"),
        description=str(job.get("Description") or "")[:500],
        status=str(job.get("Status") or ""),
        flags=str(job.get("CurrentFlag") or "None"),
        required_role=required_role,
        proposed_resource=resource.name,
        proposed_resource_id=resource.resource_id,
        proposed_date=slot.date.isoformat(),
        proposed_start=slot.start.strftime("%H:%M"),
        proposed_end=slot.end.strftime("%H:%M"),
        duration_minutes=slot.duration_minutes,
        duration_reason=duration_reason,
        resource_reason=f"{inactive_note}Selected next free slot on the assigned active site resource.",
        contractor_check="Passed",
        ppm_check="Not a PPM job",
        overlap_check="Passed",
        booking_before=slot.booking_before,
        booking_after=slot.booking_after,
        priority=str(job.get("CurrentFlag") or job.get("Status") or "Routine"),
        target_date=str(job.get("DueDate") or "Not specified"),
        confidence=duration_confidence if duration_confidence in {"Low", "Medium"} else "High",
        assumptions=warnings,
    )


def process_stale_diary(
    client: BigChangeClient,
    rules: dict[str, Any],
    resources: list[dict[str, Any]],
    audit_refs: set[str],
    *,
    run_date: dt.date,
    lookback_days: int,
    dry_run: bool,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []

    for job in fetch_incomplete_diary_jobs(client, rules, run_date=run_date, lookback_days=lookback_days):
        ref = str(job.get("Ref") or "")
        planned = parse_datetime(job.get("PlannedStart"))
        original_date = planned.date().isoformat() if planned else None
        if ref in audit_refs:
            skipped.append({"ref": ref, "site": job.get("_btr_site"), "reason": "already actioned in allocation audit"})
            continue
        if is_ppm_job(job):
            skipped.append({"ref": ref, "site": job.get("_btr_site"), "reason": "stale PPM diary entry - manual review only"})
            continue
        excluded, reason = contractor_exclusion(job, rules)
        if excluded:
            skipped.append({"ref": ref, "site": job.get("_btr_site"), "reason": reason})
            continue

        try:
            recommendation = build_reschedule_recommendation(client, job, rules, resources)
            if isinstance(recommendation, tuple):
                skipped.append({"ref": ref, "site": job.get("_btr_site"), "reason": recommendation[1]})
                continue
            record = apply_recommendation(
                client,
                recommendation,
                mode="daily_incomplete_reschedule",
                original_date=original_date,
                dry_run=dry_run,
            )
            applied.append(record)
            audit_refs.add(ref)
        except Exception as exc:  # Continue the batch on single-job failures.
            failed.append({"ref": ref, "site": job.get("_btr_site"), "error": str(exc)})
    return applied, skipped, failed


def process_unallocated(
    client: BigChangeClient,
    rules: dict[str, Any],
    audit_refs: set[str],
    *,
    run_date: dt.date,
    lookback_days: int,
    dry_run: bool,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    manual_review: list[dict[str, Any]] = []

    for job in fetch_recent_unallocated_jobs(client, run_date=run_date, lookback_days=lookback_days):
        ref = str(job.get("Ref") or "")
        site_match = identify_site(job, rules)
        if not site_match:
            continue
        site = site_match.site

        excluded, exclusion_reason = contractor_exclusion(job, rules)
        if excluded:
            item = {"ref": ref, "site": site, "reason": exclusion_reason}
            skipped.append(item)
            manual_review.append({**item, "category": "contractor"})
            continue

        ppm_allowed, ppm_reason = ppm_tech_diary_review(job, rules)
        if not ppm_allowed:
            item = {"ref": ref, "site": site, "reason": ppm_reason}
            skipped.append(item)
            manual_review.append({**item, "category": "ppm"})
            continue

        try:
            recommendation = build_recommendation(client, job, rules)
            if isinstance(recommendation, tuple):
                reason = recommendation[1]
                item = {"ref": ref, "site": site, "reason": reason}
                skipped.append(item)
                if site == BALTIC_YARD_SITE or "No suitable active" in reason:
                    manual_review.append({**item, "category": "no suitable resource"})
                continue
            mode = f"daily_allocate_{recommendation.confidence.lower()}"
            record = apply_recommendation(client, recommendation, mode=mode, dry_run=dry_run)
            applied.append(record)
            audit_refs.add(ref)
            if recommendation.confidence == "Low":
                manual_review.append(
                    {
                        "ref": ref,
                        "site": recommendation.site,
                        "reason": "low confidence allocation applied - human review recommended",
                        "category": "low confidence",
                    }
                )
        except Exception as exc:
            failed.append({"ref": ref, "site": site, "error": str(exc)})
    return applied, skipped, failed, manual_review


def workload_warnings(
    client: BigChangeClient,
    rules: dict[str, Any],
    resources: list[dict[str, Any]],
    *,
    run_date: dt.date,
    horizon_days: int = 14,
) -> list[dict[str, Any]]:
    warnings: list[dict[str, Any]] = []
    start = run_date
    end = run_date + dt.timedelta(days=horizon_days)
    for resource in resources:
        name = str(resource.get("label") or "")
        if not resource_is_active_for_jobwatch(resource):
            continue
        if resource_is_excluded(name, rules):
            continue
        if not resource_site(name, rules) or not resource_role(name, rules):
            continue
        resource_id = int(resource["id"])
        diary = client.resource_diary(resource_id, start, end)
        counts: collections.Counter[str] = collections.Counter()
        for job in diary:
            if is_cancelled_diary_job(job):
                continue
            planned = parse_datetime(job.get("PlannedStart"))
            if not planned:
                continue
            counts[planned.date().isoformat()] += 1
        for day, count in sorted(counts.items()):
            if count >= 4:
                warnings.append({"resource": name, "resource_id": resource_id, "date": day, "job_count": count})
    return warnings


def markdown_table(headers: list[str], rows: list[list[Any]]) -> str:
    if not rows:
        return "_None._"
    output = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    for row in rows:
        output.append("| " + " | ".join(str(cell).replace("\n", " ") for cell in row) + " |")
    return "\n".join(output)


def render_summary(summary: dict[str, Any]) -> str:
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
        for item in summary["applied"]
    ]
    skipped_rows = [[item.get("ref"), item.get("site", ""), item.get("reason")] for item in summary["skipped"]]
    failed_rows = [[item.get("ref"), item.get("site", ""), item.get("error")] for item in summary["failed"]]
    workload_rows = [
        [item.get("resource"), item.get("date"), item.get("job_count")]
        for item in summary["workload_warnings"]
    ]
    manual_rows = [
        [item.get("ref"), item.get("site", ""), item.get("category", ""), item.get("reason")]
        for item in summary["manual_review"]
    ]
    skipped_by_reason = collections.Counter(str(item.get("reason")) for item in summary["skipped"])
    skipped_reason_rows = [[reason, count] for reason, count in sorted(skipped_by_reason.items())]

    return f"""# BTR Daily Run - {summary["run_date"]}

**Run timestamp:** {summary["run_timestamp"]}  
**Environment:** BigChange TEST  
**Mode:** {"dry run" if summary["dry_run"] else "apply"}  
**Lookback window:** {summary["lookback_days"]} days

## Counts

| Applied | Failed | Skipped |
|---:|---:|---:|
| {len(summary["applied"])} | {len(summary["failed"])} | {len(summary["skipped"])} |

### Skipped by reason

{markdown_table(["Reason", "Count"], skipped_reason_rows)}

## Applied jobs

{markdown_table(["Ref", "Site", "Resource", "Date", "Start-End", "Confidence", "Mode"], applied_rows)}

## Skipped jobs

{markdown_table(["Ref", "Site", "Reason"], skipped_rows)}

## Failed jobs

{markdown_table(["Ref", "Site", "Error"], failed_rows)}

## Workload warnings

{markdown_table(["Resource", "Date", "Job count"], workload_rows)}

## Manual review

{markdown_table(["Ref", "Site", "Category", "Reason"], manual_rows)}
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the daily BTR allocation workflow")
    parser.add_argument("--date", default=dt.date.today().isoformat(), help="Run date in YYYY-MM-DD form")
    parser.add_argument("--lookback-days", type=int, default=14)
    parser.add_argument("--dry-run", action="store_true", help="Do not write schedules or audit records")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    run_date = dt.date.fromisoformat(args.date)
    summary: dict[str, Any] = {
        "run_date": run_date.isoformat(),
        "run_timestamp": utc_now().isoformat(),
        "dry_run": args.dry_run,
        "lookback_days": args.lookback_days,
        "applied": [],
        "skipped": [],
        "failed": [],
        "manual_review": [],
        "workload_warnings": [],
    }

    try:
        rules = load_rules()
        audit_refs = load_audit_refs()
        client = BigChangeClient()
        resources = client.resources()
        summary["resource_count"] = len(resources)

        applied, skipped, failed = process_stale_diary(
            client,
            rules,
            resources,
            audit_refs,
            run_date=run_date,
            lookback_days=args.lookback_days,
            dry_run=args.dry_run,
        )
        summary["applied"].extend(applied)
        summary["skipped"].extend(skipped)
        summary["failed"].extend(failed)

        applied, skipped, failed, manual_review = process_unallocated(
            client,
            rules,
            audit_refs,
            run_date=run_date,
            lookback_days=args.lookback_days,
            dry_run=args.dry_run,
        )
        summary["applied"].extend(applied)
        summary["skipped"].extend(skipped)
        summary["failed"].extend(failed)
        summary["manual_review"].extend(manual_review)

        summary["workload_warnings"] = workload_warnings(client, rules, resources, run_date=run_date)
    except Exception as exc:
        summary["failed"].append({"ref": "setup", "site": "", "error": str(exc)})

    output_path = DAILY_SUMMARY_DIR / f"btr-daily-run-{run_date.isoformat()}.md"
    output_path.write_text(render_summary(summary), encoding="utf-8")
    print(
        json.dumps(
            {
                "summary_path": str(output_path),
                "applied": len(summary["applied"]),
                "failed": len(summary["failed"]),
                "skipped": len(summary["skipped"]),
                "dry_run": args.dry_run,
            },
            indent=2,
        )
    )
    return 0 if not summary["failed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
