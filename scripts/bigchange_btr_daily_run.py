#!/usr/bin/env python3
"""Daily BTR allocation runner for the BigChange TEST environment.

The runner follows the daily automation prompt:
- scan 14 days of stale BTR diaries and new unallocated BTR jobs
- skip contractor/Aquilo, stale PPM, and no-resource cases
- apply eligible schedules only when --apply is passed
- append audit entries for applied changes and write a daily markdown summary
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
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
RESULT_PATH = ROOT / "automation-memory/btr-daily-run-results.json"


@dataclass
class BtrResource:
    resource_id: int
    name: str
    site: str
    role: str
    raw: dict[str, Any]


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
    if isinstance(result, dict):
        return result
    return None


def active_btr_resources(resources: list[dict[str, Any]], rules: dict[str, Any]) -> dict[int, BtrResource]:
    out: dict[int, BtrResource] = {}
    for resource in resources:
        resource_id = as_int(resource.get("id"))
        name = str(resource.get("label") or "")
        if resource_id is None:
            continue
        if not resource_is_active_for_jobwatch(resource):
            continue
        if resource_is_excluded(name, rules):
            continue
        site = resource_site(name, rules)
        role = resource_role(name, rules)
        if not site or not role:
            continue
        out[resource_id] = BtrResource(resource_id=resource_id, name=name, site=site, role=role, raw=resource)
    return out


def status_is_open(job: dict[str, Any]) -> bool:
    status_id = as_int(job.get("StatusId"))
    status = normalise(job.get("Status"))
    if status_id in CLOSED_STATUS_IDS:
        return False
    if any(word in status for word in ("complete", "cancel", "deleted", "reject")):
        return False
    return True


def resource_site_match(resource: BtrResource) -> SiteMatch:
    return SiteMatch(
        site=resource.site,
        method=f"Derived from assigned resource '{resource.name}'",
        confidence="High",
    )


def recommendation_from_same_resource(
    client: BigChangeClient,
    job: dict[str, Any],
    resource: BtrResource,
    rules: dict[str, Any],
    *,
    search_days: int,
) -> Recommendation | tuple[str, str]:
    excluded, exclusion_reason = contractor_exclusion(job, rules)
    if excluded:
        return str(job.get("Ref") or ""), exclusion_reason

    if is_ppm_job(job):
        return str(job.get("Ref") or ""), "Stale PPM diary entry requires manual review; not auto-rescheduled"

    role_match = determine_role(job)
    required_role = role_match.role or resource.role
    if required_role == "HK" and resource.role != "HK":
        return str(job.get("Ref") or ""), f"Assigned resource '{resource.name}' is not an HK resource"
    if required_role in {"Tech", "CT"} and resource.role not in {"Tech", "CT"}:
        return str(job.get("Ref") or ""), f"Assigned resource '{resource.name}' is not a Tech/CT resource"

    duration, duration_reason, duration_confidence = estimate_duration(job, rules)
    start_day = dt.date.today()
    end_day = start_day + dt.timedelta(days=search_days)
    diary = client.resource_diary(resource.resource_id, start_day, end_day)
    schedule_jobs = [entry for entry in diary if not is_cancelled_diary_job(entry)]
    working_hours_cache: dict[int, list[dict[str, Any]]] = {}

    for offset in range(search_days + 1):
        day = start_day + dt.timedelta(days=offset)
        if day.weekday() >= 5:
            continue
        windows = resource_working_windows(client, resource.resource_id, day, working_hours_cache, rules)
        blocks = diary_blocks(schedule_jobs, day)
        slot = find_slot(blocks, day, duration, windows)
        if not slot:
            continue
        slot_start = dt.datetime.combine(day, slot.start)
        slot_end = dt.datetime.combine(day, slot.end)
        if slot_has_overlap(blocks, slot_start, slot_end):
            continue
        slot.booking_before, slot.booking_after = adjacent_bookings(blocks, slot_start, slot_end)
        site_match = resource_site_match(resource)
        confidence_parts = [site_match.confidence, role_match.confidence, duration_confidence]
        if "Low" in confidence_parts:
            confidence = "Low"
        elif "Medium" in confidence_parts:
            confidence = "Medium"
        else:
            confidence = "High"
        return Recommendation(
            job_ref=str(job.get("Ref") or ""),
            job_id=int(job.get("JobId") or 0),
            site=resource.site,
            site_identification=site_match.method,
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
            resource_reason=f"Kept same active site-based resource from stale diary: {resource.name}",
            contractor_check="Passed",
            ppm_check="Not a PPM job",
            overlap_check="Passed",
            booking_before=slot.booking_before,
            booking_after=slot.booking_after,
            priority=str(job.get("CurrentFlag") or job.get("Status") or "Routine"),
            target_date=str(job.get("DueDate") or "Not specified"),
            confidence=confidence,
            assumptions=["Site derived from currently assigned resource for stale diary reschedule"],
        )

    return str(job.get("Ref") or ""), "No suitable diary slot found within search window"


def verify_schedule(
    client: BigChangeClient,
    job_ref: str,
    resource_id: int,
    schedule_date: str,
    start: str,
    end: str,
) -> tuple[bool, str]:
    planned_day = dt.date.fromisoformat(schedule_date)
    expected_start = f"{schedule_date} {start}:00"
    expected_end = f"{schedule_date} {end}:00"
    job = fetch_job(client, job_ref=job_ref)
    if not job:
        return False, "Job verification fetch failed"
    planned_start = str(job.get("PlannedStart") or "")
    resource_value = str(job.get("Resource") or "").strip()
    if planned_start[:16] != expected_start[:16]:
        return False, f"PlannedStart verification mismatch: {planned_start or 'blank'}"
    if resource_value.lower() in {"", "none", "null", "unassigned", "unallocated"}:
        return False, "Job has PlannedStart but no Resource after scheduling"

    diary = client.resource_diary(resource_id, planned_day, planned_day)
    matches = [entry for entry in diary if str(entry.get("Ref") or "") == job_ref]
    if not matches:
        return False, "Job not found on intended resource diary after scheduling"

    blocks = diary_blocks([entry for entry in diary if not is_cancelled_diary_job(entry)], planned_day)
    slot_start = dt.datetime.strptime(expected_start, "%Y-%m-%d %H:%M:%S")
    slot_end = dt.datetime.strptime(expected_end, "%Y-%m-%d %H:%M:%S")
    overlapping = [
        label
        for block_start, block_end, label in blocks
        if label.split(" ", 1)[0] != job_ref and block_start < slot_end and block_end > slot_start
    ]
    if overlapping:
        return False, f"Diary overlap found after scheduling: {'; '.join(overlapping)}"
    return True, "Verified assigned resource, diary placement, and no overlaps"


def apply_recommendation(
    client: BigChangeClient,
    recommendation: Recommendation,
    *,
    mode: str,
    apply: bool,
    original_date: str | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    schedule_dt = f"{recommendation.proposed_date} {recommendation.proposed_start}:00"
    record = {
        "timestamp": utc_now(),
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
    if not apply:
        record["dry_run"] = True
        return record

    client.schedule_job(
        recommendation.job_id,
        recommendation.proposed_resource_id,
        schedule_dt,
        recommendation.duration_minutes,
    )
    verified, verification = verify_schedule(
        client,
        recommendation.job_ref,
        recommendation.proposed_resource_id,
        recommendation.proposed_date,
        recommendation.proposed_start,
        recommendation.proposed_end,
    )
    record["verification"] = verification
    if verified:
        append_audit(record)
        return record

    # BigChange TEST has occasionally accepted PlannedStart while dropping Resource.
    client.schedule_job(
        recommendation.job_id,
        recommendation.proposed_resource_id,
        schedule_dt,
        recommendation.duration_minutes,
    )
    verified, verification = verify_schedule(
        client,
        recommendation.job_ref,
        recommendation.proposed_resource_id,
        recommendation.proposed_date,
        recommendation.proposed_start,
        recommendation.proposed_end,
    )
    record["verification"] = f"Retry after failed verification: {verification}"
    if not verified:
        raise RuntimeError(record["verification"])
    record["mode"] = f"{mode}_repair"
    append_audit(record)
    return record


def stale_diary_candidates(
    client: BigChangeClient,
    btr_resources: dict[int, BtrResource],
    *,
    lookback_days: int,
) -> list[tuple[dict[str, Any], BtrResource]]:
    today = dt.date.today()
    start = today - dt.timedelta(days=lookback_days)
    end = today - dt.timedelta(days=1)
    candidates: dict[tuple[str, int], tuple[dict[str, Any], BtrResource]] = {}
    if end < start:
        return []
    for resource in btr_resources.values():
        diary = client.resource_diary(resource.resource_id, start, end)
        for job in diary:
            planned = parse_datetime(job.get("PlannedStart"))
            ref = str(job.get("Ref") or "").strip()
            job_id = as_int(job.get("JobId"))
            if not ref or job_id is None or not planned:
                continue
            if planned.date() >= today:
                continue
            if not status_is_open(job):
                continue
            candidates[(ref, job_id)] = (job, resource)
    return [candidates[key] for key in sorted(candidates)]


def classify_unallocated_job(job: dict[str, Any], rules: dict[str, Any]) -> tuple[bool, str, str | None]:
    site_match = identify_site(job, rules)
    if not site_match:
        return False, "out_of_scope_non_btr_or_unclear_site", None
    excluded, exclusion_reason = contractor_exclusion(job, rules)
    if excluded:
        return True, exclusion_reason, site_match.site
    ppm_allowed, ppm_reason = ppm_tech_diary_review(job, rules)
    if not ppm_allowed:
        return True, ppm_reason, site_match.site
    return True, "eligible", site_match.site


def count_workload_warnings(
    client: BigChangeClient,
    btr_resources: dict[int, BtrResource],
    *,
    start: dt.date,
    end: dt.date,
) -> list[dict[str, Any]]:
    warnings: list[dict[str, Any]] = []
    for resource in btr_resources.values():
        diary = client.resource_diary(resource.resource_id, start, end)
        counts: Counter[dt.date] = Counter()
        refs: defaultdict[dt.date, list[str]] = defaultdict(list)
        for job in diary:
            if is_cancelled_diary_job(job):
                continue
            planned = parse_datetime(job.get("PlannedStart"))
            if not planned:
                continue
            counts[planned.date()] += 1
            refs[planned.date()].append(str(job.get("Ref") or ""))
        for day, count in sorted(counts.items()):
            if count >= 4:
                warnings.append(
                    {
                        "resource": resource.name,
                        "resource_id": resource.resource_id,
                        "date": day.isoformat(),
                        "job_count": count,
                        "refs": ", ".join(ref for ref in refs[day] if ref),
                    }
                )
    return warnings


def markdown_table(headers: list[str], rows: list[list[Any]]) -> str:
    if not rows:
        return "_None._"
    out = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    for row in rows:
        out.append("| " + " | ".join(str(value).replace("\n", " ") for value in row) + " |")
    return "\n".join(out)


def write_summary(
    *,
    run_date: dt.date,
    started_at: str,
    resources_count: int,
    active_resources_count: int,
    applied: list[dict[str, Any]],
    skipped: list[dict[str, Any]],
    failed: list[dict[str, Any]],
    workload_warnings: list[dict[str, Any]],
    apply: bool,
) -> Path:
    skipped_counts = Counter(str(item.get("reason") or "unspecified") for item in skipped)
    manual_review = [
        item
        for item in skipped + applied
        if any(
            token in str(item.get("reason") or item.get("mode") or "").lower()
            for token in ("ppm", "contractor", "aquilo", "no suitable resource", "low")
        )
        or str(item.get("confidence") or "").lower() == "low"
    ]
    summary_path = SUMMARY_DIR / f"btr-daily-run-{run_date.isoformat()}.md"
    lines = [
        f"# BTR Daily Run — {run_date.isoformat()}",
        "",
        f"- Run timestamp: {started_at}",
        f"- Mode: {'apply' if apply else 'dry run'}",
        f"- BigChange Resources connectivity: OK ({resources_count} resources, {active_resources_count} active BTR Tech/CT/HK resources)",
        f"- Applied: {len(applied)}",
        f"- Failed: {len(failed)}",
        f"- Skipped: {len(skipped)}",
        "",
        "## Skipped counts by reason",
        "",
        markdown_table(["Reason", "Count"], [[reason, count] for reason, count in sorted(skipped_counts.items())]),
        "",
        "## Applied jobs",
        "",
        markdown_table(
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
        markdown_table(
            ["Ref", "Reason", "Site", "Phase"],
            [[item.get("ref"), item.get("reason"), item.get("site", ""), item.get("phase", "")] for item in skipped],
        ),
        "",
        "## Failed jobs",
        "",
        markdown_table(
            ["Ref", "Error", "Phase"],
            [[item.get("ref"), item.get("error"), item.get("phase", "")] for item in failed],
        ),
        "",
        "## Workload warnings",
        "",
        markdown_table(
            ["Resource", "Date", "Job count", "Refs"],
            [
                [item.get("resource"), item.get("date"), item.get("job_count"), item.get("refs")]
                for item in workload_warnings
            ],
        ),
        "",
        "## Manual review / watch list",
        "",
        markdown_table(
            ["Ref", "Reason / Mode", "Site", "Confidence"],
            [
                [
                    item.get("ref") or item.get("job_ref"),
                    item.get("reason") or item.get("mode"),
                    item.get("site", ""),
                    item.get("confidence", ""),
                ]
                for item in manual_review
            ],
        ),
        "",
    ]
    summary_path.write_text("\n".join(lines), encoding="utf-8")
    return summary_path


def run(args: argparse.Namespace) -> int:
    started_at = utc_now()
    rules = load_rules()
    client = BigChangeClient()
    resources = client.resources()
    btr_resources = active_btr_resources(resources, rules)
    audited_refs = load_audit_refs()

    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []

    print(f"Resources connectivity OK: {len(resources)} resources; {len(btr_resources)} active BTR resources")
    print("=== Step 1: stale incomplete non-PPM diary jobs ===")
    for job, resource in stale_diary_candidates(client, btr_resources, lookback_days=args.lookback_days):
        ref = str(job.get("Ref") or "")
        planned = parse_datetime(job.get("PlannedStart"))
        site = resource.site
        if ref in audited_refs:
            skipped.append(
                {
                    "phase": "stale_diary",
                    "ref": ref,
                    "site": site,
                    "reason": "already present in allocation audit; not clearly unallocated",
                }
            )
            continue
        if is_ppm_job(job):
            skipped.append(
                {
                    "phase": "stale_diary",
                    "ref": ref,
                    "site": site,
                    "reason": "stale PPM diary entry requires manual review",
                }
            )
            continue
        try:
            result = recommendation_from_same_resource(
                client,
                job,
                resource,
                rules,
                search_days=args.search_days,
            )
            if isinstance(result, tuple):
                skipped.append({"phase": "stale_diary", "ref": ref, "site": site, "reason": result[1]})
                continue
            record = apply_recommendation(
                client,
                result,
                mode="daily_incomplete_reschedule",
                apply=args.apply,
                original_date=planned.date().isoformat() if planned else None,
            )
            applied.append(record)
            audited_refs.add(ref)
            print(f"Applied stale reschedule: {ref} -> {record['resource']} {record['scheduled_date']} {record['start']}-{record['end']}")
        except Exception as exc:  # Continue processing all jobs.
            failed.append({"phase": "stale_diary", "ref": ref, "error": str(exc)})
            print(f"Failed stale reschedule: {ref}: {exc}", file=sys.stderr)

    print("=== Step 2: unallocated BTR jobs ===")
    for job in fetch_unallocated_jobs(client, lookback_days=args.lookback_days):
        ref = str(job.get("Ref") or "")
        is_btr, reason, site = classify_unallocated_job(job, rules)
        if not is_btr:
            continue
        if reason != "eligible":
            skipped.append({"phase": "unallocated", "ref": ref, "site": site or "", "reason": reason})
            continue
        if ref in audited_refs and not is_unallocated(job):
            skipped.append({"phase": "unallocated", "ref": ref, "site": site or "", "reason": "already present in allocation audit"})
            continue
        try:
            result = build_recommendation(client, job, rules)
            if isinstance(result, tuple):
                skipped.append({"phase": "unallocated", "ref": ref, "site": site or "", "reason": result[1]})
                continue
            record = apply_recommendation(
                client,
                result,
                mode=f"daily_allocate_{result.confidence.lower()}",
                apply=args.apply,
            )
            applied.append(record)
            audited_refs.add(ref)
            print(f"Applied allocation: {ref} -> {record['resource']} {record['scheduled_date']} {record['start']}-{record['end']}")
        except Exception as exc:
            failed.append({"phase": "unallocated", "ref": ref, "error": str(exc)})
            print(f"Failed allocation: {ref}: {exc}", file=sys.stderr)

    print("=== Step 3: workload sanity check ===")
    today = dt.date.today()
    workload_warnings = count_workload_warnings(
        client,
        btr_resources,
        start=today,
        end=today + dt.timedelta(days=args.search_days),
    )

    print("=== Step 4: write daily summary ===")
    summary_path = write_summary(
        run_date=today,
        started_at=started_at,
        resources_count=len(resources),
        active_resources_count=len(btr_resources),
        applied=applied,
        skipped=skipped,
        failed=failed,
        workload_warnings=workload_warnings,
        apply=args.apply,
    )
    result = {
        "executed_at": started_at,
        "mode": "apply" if args.apply else "dry_run",
        "applied": len(applied),
        "failed": len(failed),
        "skipped": len(skipped),
        "summary_path": str(summary_path.relative_to(ROOT)),
        "applied_records": applied,
        "skipped_records": skipped,
        "failed_records": failed,
        "workload_warnings": workload_warnings,
    }
    RESULT_PATH.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in result.items() if not key.endswith("_records") and key != "workload_warnings"}, indent=2))
    return 0 if not failed else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the daily BTR BigChange allocation workflow")
    parser.add_argument("--apply", action="store_true", help="Write schedules to BigChange and append audit records")
    parser.add_argument("--lookback-days", type=int, default=14)
    parser.add_argument("--search-days", type=int, default=14)
    args = parser.parse_args()
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
