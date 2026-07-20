#!/usr/bin/env python3
"""Run the daily BTR allocation workflow for the BigChange TEST environment."""

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
    SiteMatch,
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
    is_unallocated,
    load_rules,
    normalise,
    next_working_day,
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


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


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
    result = payload.get("Result")
    if isinstance(result, list):
        return next((item for item in result if isinstance(item, dict)), None)
    if isinstance(result, dict):
        return result
    return None


def resource_name(resource: dict[str, Any]) -> str:
    return str(resource.get("label") or resource.get("ResourceName") or resource.get("Name") or "").strip()


def btr_resource_site_role(resource: dict[str, Any], rules: dict[str, Any]) -> tuple[str, str] | None:
    name = resource_name(resource)
    if not name or resource_is_excluded(name, rules):
        return None
    site = resource_site(name, rules)
    role = resource_role(name, rules)
    if not site or not role:
        return None
    return site, role


def active_btr_resources(resources: list[dict[str, Any]], rules: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        resource
        for resource in resources
        if resource_is_active_for_jobwatch(resource) and btr_resource_site_role(resource, rules)
    ]


def open_status(job: dict[str, Any]) -> bool:
    if is_cancelled_diary_job(job):
        return False
    status_id = as_int(job.get("StatusId"))
    if status_id in CLOSED_STATUS_IDS:
        return False
    status_text = normalise(job.get("Status"))
    if status_text in {"completed", "complete", "cancelled", "deleted", "rejected"}:
        return False
    return True


def resolve_site(
    job: dict[str, Any],
    rules: dict[str, Any],
    *,
    assigned_resource: dict[str, Any] | None = None,
) -> SiteMatch | None:
    if assigned_resource:
        assigned_site = resource_site(resource_name(assigned_resource), rules)
        if assigned_site:
            return SiteMatch(
                site=assigned_site,
                method=f"Matched assigned resource '{resource_name(assigned_resource)}'",
                confidence="High",
            )
    return identify_site(job, rules)


def duration_for_reschedule(job: dict[str, Any], rules: dict[str, Any]) -> tuple[int, str, str]:
    start = parse_datetime(job.get("PlannedStart"))
    end = parse_datetime(job.get("PlannedEnd"))
    if start and end and end > start:
        minutes = int((end - start).total_seconds() // 60)
        if minutes > 0:
            return minutes, "Used existing planned diary duration", "High"
    parsed = parse_duration(job.get("Duration"))
    if parsed and parsed > 0:
        return parsed, "Used existing job duration", "Medium"
    return estimate_duration(job, rules)


def find_slot_for_resource(
    client: BigChangeClient,
    resource_id: int,
    duration_minutes: int,
    rules: dict[str, Any],
    *,
    search_days: int = SEARCH_DAYS,
) -> tuple[Any | None, str | None]:
    start_day = next_working_day(dt.date.today())
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
        slot.booking_before, slot.booking_after = adjacent_bookings(blocks, slot_start, slot_end)
        return slot, None
    return None, "No suitable diary slot found within search window"


def build_reschedule_recommendation(
    client: BigChangeClient,
    job: dict[str, Any],
    rules: dict[str, Any],
    assigned_resource: dict[str, Any],
    *,
    resources: list[dict[str, Any]],
) -> Recommendation | tuple[str, str]:
    ref = str(job.get("Ref") or "")
    site_match = resolve_site(job, rules, assigned_resource=assigned_resource)
    if not site_match:
        return ref, "Site could not be identified confidently"

    assigned_name = resource_name(assigned_resource)
    assigned_role = resource_role(assigned_name, rules)
    role_match = determine_role(job)
    required_role = assigned_role or role_match.role or "Tech"
    duration, duration_reason, duration_confidence = duration_for_reschedule(job, rules)

    resource_id = as_int(assigned_resource.get("id"))
    selected_name = assigned_name
    selected_role = assigned_role or required_role
    resource_reason = "Kept the same active resource already assigned to the stale diary job"

    if not resource_id:
        return ref, "Assigned resource id missing"

    if not resource_is_active_for_jobwatch(assigned_resource):
        replacement = next(
            (
                resource
                for resource in active_btr_resources(resources, rules)
                if resource_site(resource_name(resource), rules) == site_match.site
                and resource_role(resource_name(resource), rules) in {"Tech", "CT", "HK"}
                and (required_role == "HK") == (resource_role(resource_name(resource), rules) == "HK")
            ),
            None,
        )
        if not replacement:
            return ref, f"Assigned resource '{assigned_name}' is inactive and no active site replacement was found"
        resource_id = int(replacement["id"])
        selected_name = resource_name(replacement)
        selected_role = resource_role(selected_name, rules) or required_role
        resource_reason = f"Assigned resource '{assigned_name}' is inactive; selected active site replacement"

    slot, reason = find_slot_for_resource(client, resource_id, duration, rules)
    if not slot:
        return ref, reason or "No suitable diary slot found"

    confidence_parts = [site_match.confidence, duration_confidence]
    if "Low" in confidence_parts:
        confidence = "Low"
    elif "Medium" in confidence_parts:
        confidence = "Medium"
    else:
        confidence = "High"

    return Recommendation(
        job_ref=ref,
        job_id=int(job.get("JobId") or 0),
        site=site_match.site,
        site_identification=site_match.method,
        description=str(job.get("Description") or "")[:500],
        status=str(job.get("Status") or ""),
        flags=str(job.get("CurrentFlag") or "None"),
        required_role=selected_role,
        proposed_resource=selected_name,
        proposed_resource_id=resource_id,
        proposed_date=slot.date.isoformat(),
        proposed_start=slot.start.strftime("%H:%M"),
        proposed_end=slot.end.strftime("%H:%M"),
        duration_minutes=duration,
        duration_reason=duration_reason,
        resource_reason=resource_reason,
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


def audit_record(recommendation: Recommendation, *, mode: str, original_date: str | None = None) -> dict[str, Any]:
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
    dry_run: bool = False,
) -> dict[str, Any]:
    record = audit_record(recommendation, mode=mode, original_date=original_date)
    if dry_run:
        record["dry_run"] = True
        return record

    schedule_dt = f"{recommendation.proposed_date} {recommendation.proposed_start}:00"
    client.schedule_job(
        recommendation.job_id,
        recommendation.proposed_resource_id,
        schedule_dt,
        recommendation.duration_minutes,
    )
    append_audit(record)
    return record


def verify_schedule(client: BigChangeClient, recommendation: Recommendation) -> tuple[bool, str]:
    scheduled = fetch_job(client, job_id=recommendation.job_id)
    if not scheduled:
        return False, "Job could not be fetched after scheduling"

    planned_start = parse_datetime(scheduled.get("PlannedStart"))
    resource_text = normalise(scheduled.get("Resource"))
    expected_resource = normalise(recommendation.proposed_resource)
    if not planned_start:
        return False, "Job has no PlannedStart after scheduling"
    if expected_resource and expected_resource not in resource_text:
        return False, "Job Resource did not match intended resource after scheduling"

    day = planned_start.date()
    diary = client.resource_diary(recommendation.proposed_resource_id, day, day)
    matching = [
        job
        for job in diary
        if str(job.get("Ref") or "") == recommendation.job_ref
        and parse_datetime(job.get("PlannedStart"))
        and parse_datetime(job.get("PlannedStart")).date() == day
    ]
    if not matching:
        return False, "Job did not appear on intended resource diary after scheduling"

    start = dt.datetime.combine(day, dt.datetime.strptime(recommendation.proposed_start, "%H:%M").time())
    end = start + dt.timedelta(minutes=recommendation.duration_minutes)
    for job in diary:
        if is_cancelled_diary_job(job):
            continue
        if as_int(job.get("JobId")) == recommendation.job_id:
            continue
        other_start = parse_datetime(job.get("PlannedStart"))
        other_end = parse_datetime(job.get("PlannedEnd"))
        if not other_start or other_start.date() != day:
            continue
        if not other_end:
            other_duration = parse_duration(job.get("Duration")) or 60
            other_end = other_start + dt.timedelta(minutes=other_duration)
        if other_end and slot_has_overlap([(other_start, other_end, str(job.get("Ref") or ""))], start, end):
            return False, f"Verified diary overlap with {job.get('Ref')}"
    return True, "Verified on intended resource diary with no overlaps"


def repair_dropped_resource(
    client: BigChangeClient,
    recommendation: Recommendation,
    rules: dict[str, Any],
    *,
    mode: str,
    dry_run: bool,
) -> dict[str, Any] | None:
    slot, reason = find_slot_for_resource(
        client,
        recommendation.proposed_resource_id,
        recommendation.duration_minutes,
        rules,
    )
    if not slot:
        return {
            "ref": recommendation.job_ref,
            "status": "failed",
            "error": f"Resource dropped and repair slot failed: {reason}",
        }

    repaired = Recommendation(
        **{
            **recommendation.__dict__,
            "proposed_date": slot.date.isoformat(),
            "proposed_start": slot.start.strftime("%H:%M"),
            "proposed_end": slot.end.strftime("%H:%M"),
            "booking_before": slot.booking_before,
            "booking_after": slot.booking_after,
        }
    )
    record = apply_recommendation(client, repaired, mode=f"{mode}_repair", dry_run=dry_run)
    if dry_run:
        return {"ref": repaired.job_ref, "status": "dry_run_repair", **record}
    ok, message = verify_schedule(client, repaired)
    return {
        "ref": repaired.job_ref,
        "status": "applied" if ok else "failed",
        "verification": message,
        **record,
    }


def fetch_stale_diary_items(
    client: BigChangeClient,
    resources: list[dict[str, Any]],
    rules: dict[str, Any],
    *,
    lookback_days: int = LOOKBACK_DAYS,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    today = dt.date.today()
    start = today - dt.timedelta(days=lookback_days)
    end = today - dt.timedelta(days=1)
    candidates: dict[str, dict[str, Any]] = {}
    ppm_manual: dict[str, dict[str, Any]] = {}

    for resource in resources:
        site_role = btr_resource_site_role(resource, rules)
        if not site_role:
            continue
        site, role = site_role
        resource_id = as_int(resource.get("id"))
        if not resource_id:
            continue
        for job in client.resource_diary(resource_id, start, end):
            planned = parse_datetime(job.get("PlannedStart"))
            if not planned or planned.date() >= today or planned.date() < start:
                continue
            if not open_status(job):
                continue
            ref = str(job.get("Ref") or "").strip()
            key = str(job.get("JobId") or ref)
            if not ref:
                continue
            item = {
                "job": job,
                "resource": resource,
                "resource_id": resource_id,
                "resource_name": resource_name(resource),
                "site": site,
                "role": role,
                "planned": planned.date().isoformat(),
            }
            if is_ppm_job(job):
                ppm_manual[key] = item
            else:
                candidates[key] = item
    return list(candidates.values()), list(ppm_manual.values())


def count_workload_warnings(
    client: BigChangeClient,
    resources: list[dict[str, Any]],
    rules: dict[str, Any],
    *,
    horizon_days: int = SEARCH_DAYS,
) -> list[dict[str, Any]]:
    start = next_working_day(dt.date.today())
    end = start + dt.timedelta(days=horizon_days)
    warnings: list[dict[str, Any]] = []

    for resource in active_btr_resources(resources, rules):
        resource_id = as_int(resource.get("id"))
        if not resource_id:
            continue
        counts: Counter[str] = Counter()
        for job in client.resource_diary(resource_id, start, end):
            if is_cancelled_diary_job(job):
                continue
            planned = parse_datetime(job.get("PlannedStart"))
            if not planned:
                continue
            counts[planned.date().isoformat()] += 1
        for day, count in sorted(counts.items()):
            if count >= 4:
                warnings.append({"resource": resource_name(resource), "date": day, "job_count": count})
    return warnings


def render_table(rows: list[dict[str, Any]], columns: list[tuple[str, str]]) -> str:
    if not rows:
        return "_None_"
    headers = [label for label, _key in columns]
    lines = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    for row in rows:
        values = [str(row.get(key, "") or "") for _label, key in columns]
        lines.append("| " + " | ".join(value.replace("\n", " ") for value in values) + " |")
    return "\n".join(lines)


def write_summary(summary: dict[str, Any]) -> Path:
    run_date = dt.date.today().isoformat()
    path = SUMMARY_DIR / f"btr-daily-run-{run_date}.md"
    applied = summary["applied"]
    skipped = summary["skipped"]
    failed = summary["failed"]
    workload = summary["workload_warnings"]
    manual = summary["manual_review"]

    skipped_by_reason = Counter(str(item.get("reason") or "unspecified") for item in skipped)
    content = [
        f"# BTR Daily Allocation Run - {run_date}",
        "",
        f"**Run timestamp:** {summary['run_timestamp']}",
        f"**Mode:** {'dry run' if summary['dry_run'] else 'applied to BigChange TEST'}",
        f"**Lookback window:** {summary['lookback_start']} to {summary['lookback_end']}",
        "",
        "## Counts",
        "",
        f"- Applied: {len(applied)}",
        f"- Failed: {len(failed)}",
        f"- Skipped: {len(skipped)}",
        f"- Manual review: {len(manual)}",
        "",
        "### Skipped by reason",
        "",
        render_table(
            [{"reason": reason, "count": count} for reason, count in sorted(skipped_by_reason.items())],
            [("Reason", "reason"), ("Count", "count")],
        ),
        "",
        "## Applied jobs",
        "",
        render_table(
            applied,
            [
                ("Ref", "job_ref"),
                ("Site", "site"),
                ("Resource", "resource"),
                ("Date", "scheduled_date"),
                ("Start-End", "time"),
                ("Confidence", "confidence"),
                ("Mode", "mode"),
            ],
        ),
        "",
        "## Skipped jobs",
        "",
        render_table(skipped, [("Ref", "ref"), ("Reason", "reason")]),
        "",
        "## Failed jobs",
        "",
        render_table(failed, [("Ref", "ref"), ("Error", "error")]),
        "",
        "## Workload warnings (4+ jobs in one day)",
        "",
        render_table(workload, [("Resource", "resource"), ("Date", "date"), ("Job count", "job_count")]),
        "",
        "## Manual review",
        "",
        render_table(manual, [("Ref", "ref"), ("Reason", "reason"), ("Site", "site"), ("Resource", "resource")]),
        "",
    ]
    path.write_text("\n".join(content), encoding="utf-8")
    return path


def run_daily(*, dry_run: bool = False) -> dict[str, Any]:
    rules = load_rules()
    client = BigChangeClient()
    resources = client.resources()
    active_count = sum(1 for resource in resources if resource_is_active_for_jobwatch(resource))
    audit_refs = load_audit_refs()
    today = dt.date.today()

    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    manual_review: list[dict[str, Any]] = []

    stale, stale_ppm = fetch_stale_diary_items(client, resources, rules)
    for item in stale_ppm:
        manual_review.append(
            {
                "ref": item["job"].get("Ref"),
                "reason": "Stale PPM diary entry requires manual review only",
                "site": item["site"],
                "resource": item["resource_name"],
            }
        )

    for item in sorted(stale, key=lambda value: (value["planned"], str(value["job"].get("Ref") or ""))):
        job = item["job"]
        ref = str(job.get("Ref") or "")
        if ref in audit_refs:
            skipped.append({"ref": ref, "reason": "already in allocation audit log"})
            continue
        try:
            recommendation = build_reschedule_recommendation(
                client,
                job,
                rules,
                item["resource"],
                resources=resources,
            )
            if isinstance(recommendation, tuple):
                skipped.append({"ref": ref, "reason": recommendation[1]})
                continue
            record = apply_recommendation(
                client,
                recommendation,
                mode="daily_incomplete_reschedule",
                original_date=item["planned"],
                dry_run=dry_run,
            )
            if dry_run:
                applied.append({**record, "time": f"{record['start']}-{record['end']}"})
                continue
            ok, message = verify_schedule(client, recommendation)
            if not ok and "Resource" in message:
                repair = repair_dropped_resource(
                    client,
                    recommendation,
                    rules,
                    mode="daily_incomplete_reschedule",
                    dry_run=dry_run,
                )
                if repair and repair.get("status") == "applied":
                    repair["time"] = f"{repair['start']}-{repair['end']}"
                    applied.append(repair)
                    continue
            if ok:
                record["verification"] = message
                record["time"] = f"{record['start']}-{record['end']}"
                applied.append(record)
            else:
                failed.append({"ref": ref, "error": message})
                manual_review.append(
                    {
                        "ref": ref,
                        "reason": f"Stale non-PPM reschedule verification failed: {message}",
                        "site": item["site"],
                        "resource": item["resource_name"],
                    }
                )
        except Exception as exc:  # Keep the daily batch moving.
            failed.append({"ref": ref, "error": str(exc)})
            manual_review.append(
                {
                    "ref": ref,
                    "reason": f"Stale non-PPM reschedule failed: {exc}",
                    "site": item["site"],
                    "resource": item["resource_name"],
                }
            )

    unallocated_jobs = fetch_unallocated_jobs(client, LOOKBACK_DAYS)
    for job in sorted(unallocated_jobs, key=lambda value: str(value.get("Ref") or "")):
        ref = str(job.get("Ref") or "")
        site_match = identify_site(job, rules)
        if not site_match:
            continue

        excluded, exclusion_reason = contractor_exclusion(job, rules)
        if excluded:
            skipped.append({"ref": ref, "reason": exclusion_reason})
            manual_review.append(
                {"ref": ref, "reason": "Contractor/Aquilo exclusion", "site": site_match.site, "resource": ""}
            )
            continue

        ppm_allowed, ppm_reason = ppm_tech_diary_review(job, rules)
        if not ppm_allowed:
            skipped.append({"ref": ref, "reason": ppm_reason})
            manual_review.append({"ref": ref, "reason": ppm_reason, "site": site_match.site, "resource": ""})
            continue

        try:
            result = build_recommendation(client, job, rules)
            if isinstance(result, tuple):
                skipped.append({"ref": ref, "reason": result[1]})
                if site_match.site == "Baltic Yard" or "No suitable active site-based resource" in result[1]:
                    manual_review.append(
                        {"ref": ref, "reason": "No suitable resource", "site": site_match.site, "resource": ""}
                    )
                continue

            record = apply_recommendation(
                client,
                result,
                mode=f"daily_allocate_{result.confidence.lower()}",
                dry_run=dry_run,
            )
            if dry_run:
                record["time"] = f"{record['start']}-{record['end']}"
                applied.append(record)
                continue
            ok, message = verify_schedule(client, result)
            if not ok and "Resource" in message:
                repair = repair_dropped_resource(
                    client,
                    result,
                    rules,
                    mode=f"daily_allocate_{result.confidence.lower()}",
                    dry_run=dry_run,
                )
                if repair and repair.get("status") == "applied":
                    repair["time"] = f"{repair['start']}-{repair['end']}"
                    applied.append(repair)
                    continue
            if ok:
                record["verification"] = message
                record["time"] = f"{record['start']}-{record['end']}"
                applied.append(record)
                if result.confidence == "Low":
                    manual_review.append(
                        {
                            "ref": ref,
                            "reason": "Low-confidence auto-allocation requires human review",
                            "site": result.site,
                            "resource": result.proposed_resource,
                        }
                    )
            else:
                failed.append({"ref": ref, "error": message})
        except Exception as exc:
            failed.append({"ref": ref, "error": str(exc)})

    workload_warnings = count_workload_warnings(client, resources, rules)
    summary = {
        "run_timestamp": utc_now().isoformat(),
        "dry_run": dry_run,
        "resources_total": len(resources),
        "active_resources": active_count,
        "lookback_start": (today - dt.timedelta(days=LOOKBACK_DAYS)).isoformat(),
        "lookback_end": today.isoformat(),
        "applied": applied,
        "skipped": skipped,
        "failed": failed,
        "manual_review": manual_review,
        "workload_warnings": workload_warnings,
    }
    summary_path = write_summary(summary)
    summary["summary_path"] = str(summary_path.relative_to(ROOT))
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description="Run daily BTR BigChange allocation workflow")
    parser.add_argument("--dry-run", action="store_true", help="Do not write schedules or append audit records")
    args = parser.parse_args()

    try:
        summary = run_daily(dry_run=args.dry_run)
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, indent=2), file=sys.stderr)
        return 1

    printable = {
        "summary_path": summary["summary_path"],
        "applied": len(summary["applied"]),
        "failed": len(summary["failed"]),
        "skipped": len(summary["skipped"]),
        "manual_review": len(summary["manual_review"]),
        "workload_warnings": len(summary["workload_warnings"]),
        "dry_run": summary["dry_run"],
    }
    print(json.dumps(printable, indent=2))
    return 0 if not summary["failed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
