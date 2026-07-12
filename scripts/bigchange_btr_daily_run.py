#!/usr/bin/env python3
"""Run the daily BigChange BTR allocation workflow."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from bigchange_btr_allocation import (  # noqa: E402
    CLOSED_STATUS_IDS,
    BigChangeClient,
    Recommendation,
    as_int,
    build_recommendation,
    choose_resource,
    contractor_exclusion,
    determine_role,
    estimate_duration,
    fetch_unallocated_jobs,
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
)

AUDIT_PATH = ROOT / "automation-memory/btr-allocation-audit.jsonl"
SUMMARY_DIR = ROOT / "automation-memory"
LOOKBACK_DAYS = 14


@dataclass
class DailyPlan:
    job_ref: str
    job_id: int
    site: str
    resource: str
    resource_id: int
    scheduled_date: str
    start: str
    end: str
    duration_minutes: int
    confidence: str
    mode: str
    original_date: str | None = None
    notes: list[str] = field(default_factory=list)


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
    if isinstance(result, list) and result:
        return result[0] if isinstance(result[0], dict) else None
    return result if isinstance(result, dict) else None


def append_audit(record: dict[str, Any]) -> None:
    AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with AUDIT_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")


def job_ref(job: dict[str, Any]) -> str:
    return str(job.get("Ref") or "").strip()


def job_id(job: dict[str, Any]) -> int:
    return int(job.get("JobId") or job.get("id") or 0)


def status_is_open(job: dict[str, Any]) -> bool:
    status = normalise(job.get("Status"))
    if any(token in status for token in ("cancelled", "canceled", "deleted", "rejected", "completed", "complete")):
        return False
    status_id = as_int(job.get("StatusId"))
    return status_id not in CLOSED_STATUS_IDS


def resource_id_from_job(job: dict[str, Any]) -> int | None:
    for field_name in ("ResourceId", "resourceId", "ResourceID", "ResId", "resId"):
        value = as_int(job.get(field_name))
        if value:
            return value
    return None


def resolve_resource(resources: list[dict[str, Any]], job: dict[str, Any]) -> dict[str, Any] | None:
    by_id = {as_int(resource.get("id")): resource for resource in resources if as_int(resource.get("id"))}
    resource_id = resource_id_from_job(job)
    if resource_id in by_id:
        return by_id[resource_id]

    resource_name = normalise(job.get("Resource") or job.get("ResourceName"))
    if not resource_name:
        return None

    for resource in resources:
        label = normalise(resource.get("label"))
        if label == resource_name:
            return resource
    for resource in resources:
        label = normalise(resource.get("label"))
        if resource_name in label or label in resource_name:
            return resource
    return None


def resource_label(resource: dict[str, Any] | None, job: dict[str, Any] | None = None) -> str:
    if resource:
        return str(resource.get("label") or "").strip()
    if job:
        return str(job.get("Resource") or job.get("ResourceName") or "").strip()
    return ""


def site_for_job_or_resource(job: dict[str, Any], rules: dict[str, Any], resource_name: str = "") -> str | None:
    resource_matched_site = resource_site(resource_name, rules) if resource_name else None
    if resource_matched_site:
        return resource_matched_site
    site_match = identify_site(job, rules)
    return site_match.site if site_match else None


def duration_for_job(job: dict[str, Any], rules: dict[str, Any]) -> tuple[int, str, str]:
    planned_start = parse_datetime(job.get("PlannedStart"))
    planned_end = parse_datetime(job.get("PlannedEnd"))
    if planned_start and planned_end and planned_end > planned_start:
        minutes = int((planned_end - planned_start).total_seconds() // 60)
        if minutes > 0:
            return minutes, "Used existing planned start/end duration", "High"

    parsed = parse_duration(job.get("Duration"))
    if parsed:
        return parsed, "Used existing BigChange duration", "Medium"

    return estimate_duration(job, rules)


def recommendation_to_plan(recommendation: Recommendation, mode: str, original_date: str | None = None) -> DailyPlan:
    return DailyPlan(
        job_ref=recommendation.job_ref,
        job_id=recommendation.job_id,
        site=recommendation.site,
        resource=recommendation.proposed_resource,
        resource_id=recommendation.proposed_resource_id,
        scheduled_date=recommendation.proposed_date,
        start=recommendation.proposed_start,
        end=recommendation.proposed_end,
        duration_minutes=recommendation.duration_minutes,
        confidence=recommendation.confidence,
        mode=mode,
        original_date=original_date,
        notes=list(recommendation.assumptions),
    )


def fetch_stale_diary_jobs(
    client: BigChangeClient,
    rules: dict[str, Any],
    resources: list[dict[str, Any]],
    lookback_days: int,
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    today = dt.date.today()
    start = today - dt.timedelta(days=lookback_days)
    rows = client.jobs_list(
        {
            "Start": start.isoformat(),
            "End": today.isoformat(),
            "DateOptionId": 0,
            "Allocated": 1,
            "ExcludeNullPlannedDates": 1,
            "includeExtra": 1,
        }
    )

    candidates: list[dict[str, Any]] = []
    manual_ppm: list[dict[str, str]] = []
    seen_refs: set[str] = set()

    for job in rows:
        ref = job_ref(job)
        if not ref or ref in seen_refs:
            continue
        seen_refs.add(ref)
        planned = parse_datetime(job.get("PlannedStart"))
        if not planned or planned.date() < start or planned.date() >= today:
            continue
        if not status_is_open(job) or is_cancelled_diary_job(job):
            continue

        assigned_resource = resolve_resource(resources, job)
        assigned_name = resource_label(assigned_resource, job)
        site = site_for_job_or_resource(job, rules, assigned_name)
        if not site:
            continue

        if is_ppm_job(job):
            manual_ppm.append(
                {
                    "ref": ref,
                    "site": site,
                    "reason": "stale PPM diary entry requires manual review only",
                }
            )
            continue

        candidates.append(job)

    return candidates, manual_ppm


def build_reschedule_plan(
    client: BigChangeClient,
    rules: dict[str, Any],
    resources: list[dict[str, Any]],
    job: dict[str, Any],
) -> DailyPlan | tuple[str, str]:
    ref = job_ref(job)
    excluded, exclusion_reason = contractor_exclusion(job, rules)
    if excluded:
        return ref, exclusion_reason
    if is_ppm_job(job):
        return ref, "stale PPM diary entry requires manual review only"

    assigned_resource = resolve_resource(resources, job)
    assigned_name = resource_label(assigned_resource, job)
    site = site_for_job_or_resource(job, rules, assigned_name)
    if not site:
        return ref, "BTR site could not be identified from job or assigned resource"

    current_role = resource_role(assigned_name, rules) if assigned_name else None
    role = current_role or determine_role(job).role
    if not role:
        return ref, "resource role could not be identified"

    duration, _duration_reason, duration_confidence = duration_for_job(job, rules)
    preferred_resource = assigned_name if assigned_resource and resource_is_active_for_jobwatch(assigned_resource) else None
    notes: list[str] = []
    if assigned_resource and not resource_is_active_for_jobwatch(assigned_resource):
        notes.append(f"Original resource inactive; reassigned from {assigned_name}")
    if assigned_name and resource_is_excluded(assigned_name, rules):
        notes.append(f"Original resource excluded by rules; reassigned from {assigned_name}")
        preferred_resource = None

    resource, slot, warnings = choose_resource(
        client,
        site,
        role,
        duration,
        rules,
        preferred_resource=preferred_resource,
    )
    if not resource or not slot:
        return ref, "; ".join(warnings)

    planned = parse_datetime(job.get("PlannedStart"))
    confidence = "High" if preferred_resource and duration_confidence == "High" else "Medium"
    return DailyPlan(
        job_ref=ref,
        job_id=job_id(job),
        site=site,
        resource=resource.name,
        resource_id=resource.resource_id,
        scheduled_date=slot.date.isoformat(),
        start=slot.start.strftime("%H:%M"),
        end=slot.end.strftime("%H:%M"),
        duration_minutes=slot.duration_minutes,
        confidence=confidence,
        mode="daily_incomplete_reschedule",
        original_date=planned.date().isoformat() if planned else None,
        notes=notes + warnings,
    )


def schedule_datetime(plan: DailyPlan) -> dt.datetime:
    return dt.datetime.strptime(f"{plan.scheduled_date} {plan.start}", "%Y-%m-%d %H:%M")


def plan_record(plan: DailyPlan, verification: dict[str, Any] | None = None) -> dict[str, Any]:
    record: dict[str, Any] = {
        "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
        "job_ref": plan.job_ref,
        "job_id": plan.job_id,
        "site": plan.site,
        "resource": plan.resource,
        "resource_id": plan.resource_id,
        "scheduled_date": plan.scheduled_date,
        "start": plan.start,
        "end": plan.end,
        "duration_minutes": plan.duration_minutes,
        "confidence": plan.confidence,
        "mode": plan.mode,
        "overlap_check": "Passed",
    }
    if plan.original_date:
        record["original_date"] = plan.original_date
    if plan.notes:
        record["notes"] = plan.notes
    if verification:
        record["verification"] = verification
    return record


def same_resource(job: dict[str, Any] | None, plan: DailyPlan) -> bool:
    if not job:
        return False
    resource_id = resource_id_from_job(job)
    if resource_id and resource_id == plan.resource_id:
        return True
    resource_text = normalise(job.get("Resource") or job.get("ResourceName"))
    return bool(resource_text and (normalise(plan.resource) in resource_text or resource_text in normalise(plan.resource)))


def verify_schedule(client: BigChangeClient, plan: DailyPlan) -> tuple[bool, dict[str, Any]]:
    slot_start = schedule_datetime(plan)
    slot_end = slot_start + dt.timedelta(minutes=plan.duration_minutes)
    job = fetch_job(client, job_id=plan.job_id)
    planned = parse_datetime(job.get("PlannedStart")) if job else None
    resource_ok = same_resource(job, plan)
    planned_ok = bool(planned and planned == slot_start)

    diary = client.resource_diary(plan.resource_id, slot_start.date(), slot_start.date())
    diary_matches = [
        entry
        for entry in diary
        if job_ref(entry) == plan.job_ref and parse_datetime(entry.get("PlannedStart")) == slot_start
    ]
    overlap_labels: list[str] = []
    for entry in diary:
        if is_cancelled_diary_job(entry):
            continue
        if job_ref(entry) == plan.job_ref or job_id(entry) == plan.job_id:
            continue
        other_start = parse_datetime(entry.get("PlannedStart"))
        other_end = parse_datetime(entry.get("PlannedEnd"))
        if not other_start:
            continue
        if not other_end:
            duration = parse_duration(entry.get("Duration")) or 60
            other_end = other_start + dt.timedelta(minutes=duration)
        if slot_start < other_end and slot_end > other_start:
            overlap_labels.append(f"{job_ref(entry)} {other_start.strftime('%H:%M')}-{other_end.strftime('%H:%M')}")

    detail = {
        "resource_retained": resource_ok,
        "planned_start_retained": planned_ok,
        "diary_match_count": len(diary_matches),
        "overlaps": overlap_labels,
    }
    return bool(resource_ok and planned_ok and diary_matches and not overlap_labels), detail


def apply_plan(client: BigChangeClient, plan: DailyPlan, *, dry_run: bool = False) -> tuple[dict[str, Any] | None, str | None]:
    if dry_run:
        return plan_record(plan, {"dry_run": True}), None

    schedule_dt = f"{plan.scheduled_date} {plan.start}:00"
    client.schedule_job(plan.job_id, plan.resource_id, schedule_dt, plan.duration_minutes)

    verification: dict[str, Any] = {}
    ok = False
    for attempt in range(3):
        time.sleep(1 + attempt)
        ok, verification = verify_schedule(client, plan)
        if ok:
            break
        if verification.get("planned_start_retained") and not verification.get("resource_retained"):
            client.schedule_job(plan.job_id, plan.resource_id, schedule_dt, plan.duration_minutes)
            plan.notes.append("Re-applied after BigChange retained planned start without resource")

    record = plan_record(plan, verification)
    append_audit(record)
    if not ok:
        return record, f"verification failed: {verification}"
    return record, None


def process_stale_jobs(
    client: BigChangeClient,
    rules: dict[str, Any],
    resources: list[dict[str, Any]],
    audit_refs: set[str],
    skipped: list[dict[str, str]],
    failed: list[dict[str, str]],
    *,
    dry_run: bool,
) -> list[dict[str, Any]]:
    applied: list[dict[str, Any]] = []
    stale_jobs, manual_ppm = fetch_stale_diary_jobs(client, rules, resources, LOOKBACK_DAYS)
    skipped.extend(manual_ppm)

    for job in sorted(stale_jobs, key=job_ref):
        ref = job_ref(job)
        assigned_resource = resolve_resource(resources, job)
        site = site_for_job_or_resource(job, rules, resource_label(assigned_resource, job)) or ""
        if ref in audit_refs:
            skipped.append({"ref": ref, "site": site, "reason": "already present in allocation audit"})
            continue
        result = build_reschedule_plan(client, rules, resources, job)
        if isinstance(result, tuple):
            skipped.append({"ref": result[0], "site": site, "reason": result[1]})
            continue
        record, error = apply_plan(client, result, dry_run=dry_run)
        if record:
            applied.append(record)
            audit_refs.add(ref)
        if error:
            failed.append({"ref": ref, "error": error})
    return applied


def process_unallocated_jobs(
    client: BigChangeClient,
    rules: dict[str, Any],
    audit_refs: set[str],
    skipped: list[dict[str, str]],
    failed: list[dict[str, str]],
    *,
    dry_run: bool,
) -> list[dict[str, Any]]:
    applied: list[dict[str, Any]] = []
    jobs = fetch_unallocated_jobs(client, lookback_days=LOOKBACK_DAYS)

    for job in sorted(jobs, key=job_ref):
        ref = job_ref(job)
        site_match = identify_site(job, rules)
        if not site_match:
            continue

        excluded, exclusion_reason = contractor_exclusion(job, rules)
        if excluded:
            skipped.append({"ref": ref, "site": site_match.site, "reason": exclusion_reason})
            continue

        ppm_allowed, ppm_reason = ppm_tech_diary_review(job, rules)
        if not ppm_allowed:
            skipped.append({"ref": ref, "site": site_match.site, "reason": ppm_reason})
            continue

        result = build_recommendation(client, job, rules)
        if isinstance(result, tuple):
            skipped.append({"ref": result[0], "site": site_match.site, "reason": result[1]})
            continue

        mode = f"daily_allocate_{result.confidence.lower()}"
        plan = recommendation_to_plan(result, mode)
        if ref in audit_refs:
            plan.notes.append("Previously audited but currently unallocated again")

        record, error = apply_plan(client, plan, dry_run=dry_run)
        if record:
            applied.append(record)
            audit_refs.add(ref)
        if error:
            failed.append({"ref": ref, "error": error})
    return applied


def active_btr_resources(resources: list[dict[str, Any]], rules: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for resource in resources:
        name = str(resource.get("label") or "")
        if not resource_is_active_for_jobwatch(resource):
            continue
        if resource_is_excluded(name, rules):
            continue
        if not resource_site(name, rules) or not resource_role(name, rules):
            continue
        result.append(resource)
    return result


def collect_workload_warnings(
    client: BigChangeClient,
    rules: dict[str, Any],
    resources: list[dict[str, Any]],
    applied: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    today = dt.date.today()
    scheduled_dates = [
        dt.date.fromisoformat(str(record["scheduled_date"]))
        for record in applied
        if record.get("scheduled_date")
    ]
    end = max(scheduled_dates) if scheduled_dates else today + dt.timedelta(days=14)
    end = max(end, today + dt.timedelta(days=14))

    warnings: list[dict[str, Any]] = []
    for resource in active_btr_resources(resources, rules):
        resource_id = int(resource["id"])
        name = str(resource.get("label") or "")
        diary = client.resource_diary(resource_id, today, end)
        counts: Counter[str] = Counter()
        refs_by_day: defaultdict[str, list[str]] = defaultdict(list)
        for entry in diary:
            if is_cancelled_diary_job(entry):
                continue
            planned = parse_datetime(entry.get("PlannedStart"))
            if not planned:
                continue
            day = planned.date().isoformat()
            counts[day] += 1
            refs_by_day[day].append(job_ref(entry))
        for day, count in sorted(counts.items()):
            if count >= 4:
                warnings.append(
                    {
                        "resource": name,
                        "date": day,
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
        values = [str(value).replace("\n", " ").replace("|", "/") for value in row]
        lines.append("| " + " | ".join(values) + " |")
    return "\n".join(lines)


def write_summary(
    *,
    run_at: dt.datetime,
    applied: list[dict[str, Any]],
    skipped: list[dict[str, str]],
    failed: list[dict[str, str]],
    workload_warnings: list[dict[str, Any]],
    dry_run: bool,
) -> Path:
    reason_counts = Counter(item.get("reason", "unknown") for item in skipped)
    manual_review = [
        item
        for item in skipped
        if any(token in item.get("reason", "").lower() for token in ("ppm", "contractor", "aquilo", "no suitable", "baltic"))
    ]
    low_confidence = [record for record in applied if record.get("confidence") == "Low"]

    applied_rows = [
        [
            record.get("job_ref", ""),
            record.get("site", ""),
            record.get("resource", ""),
            record.get("scheduled_date", ""),
            f"{record.get('start', '')}-{record.get('end', '')}",
            record.get("confidence", ""),
            record.get("mode", ""),
        ]
        for record in applied
    ]
    skipped_rows = [[item.get("ref", ""), item.get("site", ""), item.get("reason", "")] for item in skipped]
    failed_rows = [[item.get("ref", ""), item.get("error", "")] for item in failed]
    workload_rows = [
        [item["resource"], item["date"], item["job_count"], item["refs"]]
        for item in workload_warnings
    ]
    manual_rows = [[item.get("ref", ""), item.get("site", ""), item.get("reason", "")] for item in manual_review]
    low_rows = [
        [
            record.get("job_ref", ""),
            record.get("site", ""),
            record.get("resource", ""),
            record.get("scheduled_date", ""),
            f"{record.get('start', '')}-{record.get('end', '')}",
        ]
        for record in low_confidence
    ]

    summary = f"""# BTR Daily Allocation Run - {run_at.date().isoformat()}

**Run timestamp:** {run_at.isoformat()}  
**Mode:** {"dry run" if dry_run else "applied to BigChange TEST"}

## Counts

| Metric | Count |
|---|---:|
| Applied | {len(applied)} |
| Failed | {len(failed)} |
| Skipped | {len(skipped)} |

### Skipped by reason

{markdown_table(["Reason", "Count"], [[reason, count] for reason, count in sorted(reason_counts.items())])}

## Applied jobs

{markdown_table(["Ref", "Site", "Resource", "Date", "Start-End", "Confidence", "Mode"], applied_rows)}

## Skipped jobs

{markdown_table(["Ref", "Site", "Reason"], skipped_rows)}

## Failed jobs

{markdown_table(["Ref", "Error"], failed_rows)}

## Workload warnings

{markdown_table(["Resource", "Date", "Job count", "Refs"], workload_rows)}

## Manual review

{markdown_table(["Ref", "Site", "Reason"], manual_rows)}

## Low-confidence applied jobs

{markdown_table(["Ref", "Site", "Resource", "Date", "Start-End"], low_rows)}
"""
    path = SUMMARY_DIR / f"btr-daily-run-{run_at.date().isoformat()}.md"
    path.write_text(summary, encoding="utf-8")
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the daily BTR allocation workflow")
    parser.add_argument("--dry-run", action="store_true", help="Plan and summarize without writing to BigChange or audit")
    args = parser.parse_args()

    run_at = dt.datetime.now(dt.timezone.utc)
    rules = load_rules()
    audit_refs = load_audit_refs()
    client = BigChangeClient()
    resources = client.resources()

    # Step 0: a Resources call above verifies API connectivity and active-resource metadata.
    skipped: list[dict[str, str]] = []
    failed: list[dict[str, str]] = []
    applied: list[dict[str, Any]] = []

    applied.extend(
        process_stale_jobs(
            client,
            rules,
            resources,
            audit_refs,
            skipped,
            failed,
            dry_run=args.dry_run,
        )
    )
    applied.extend(
        process_unallocated_jobs(
            client,
            rules,
            audit_refs,
            skipped,
            failed,
            dry_run=args.dry_run,
        )
    )

    workload_warnings = collect_workload_warnings(client, rules, resources, applied)
    summary_path = write_summary(
        run_at=run_at,
        applied=applied,
        skipped=skipped,
        failed=failed,
        workload_warnings=workload_warnings,
        dry_run=args.dry_run,
    )

    print(
        json.dumps(
            {
                "summary": str(summary_path.relative_to(ROOT)),
                "applied": len(applied),
                "skipped": len(skipped),
                "failed": len(failed),
                "dry_run": args.dry_run,
            },
            indent=2,
        )
    )
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
