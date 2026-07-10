#!/usr/bin/env python3
"""Execute approved BTR allocation plan: reschedule incomplete + allocate unscheduled."""

from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from bigchange_btr_allocation import (  # noqa: E402
    BigChangeClient,
    Recommendation,
    build_recommendation,
    fetch_unallocated_jobs,
    load_rules,
)


DETAIL_PATH = ROOT / "automation-memory/btr-30day-review-detail.json"
AUDIT_PATH = ROOT / "automation-memory/btr-allocation-audit.jsonl"
RESULT_PATH = ROOT / "automation-memory/btr-batch-execution-results.json"

SKIP_REFS = {
    "DLFF276866~1",
    "JOB278036~3",
    "EOT284781~1",
    "JOB284807",
    "JOB284790",
    "DLFF284757",
    "JOB278533",
    "JOB274501",
}

PHASE1_REFS = {
    "GRANQ247638",
    "JOB282913",
    "JOB282658",
    "DLFF278603",
    "JOB278609",
    "JOB278174",
    "JOB282501",
}


def load_detail() -> dict:
    return json.loads(DETAIL_PATH.read_text(encoding="utf-8"))


def load_applied_refs() -> set[str]:
    refs: set[str] = set(SKIP_REFS)
    if AUDIT_PATH.exists():
        for line in AUDIT_PATH.read_text(encoding="utf-8").splitlines():
            if line.strip():
                refs.add(json.loads(line)["job_ref"])
    return refs


def fetch_job(client: BigChangeClient, *, job_id: int | None = None, job_ref: str | None = None) -> dict | None:
    params: dict = {}
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
        return result[0]
    if isinstance(result, dict):
        return result
    return None


def append_audit(record: dict) -> None:
    AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with AUDIT_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")


def apply_recommendation(
    client: BigChangeClient,
    recommendation: Recommendation,
    job_id: int,
    *,
    mode: str,
    original_date: str | None = None,
) -> dict:
    schedule_dt = f"{recommendation.proposed_date} {recommendation.proposed_start}:00"
    client.schedule_job(job_id, recommendation.proposed_resource_id, schedule_dt, recommendation.duration_minutes)
    record = {
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
    append_audit(record)
    return record


def resource_short_name(full_name: str) -> str:
    if " - " in full_name:
        return full_name.split(" - ", 1)[1].strip()
    parts = full_name.split()
    if len(parts) >= 2:
        return " ".join(parts[-2:])
    return full_name.strip()


def run_phase1(client: BigChangeClient, rules: dict, detail: dict, applied: set[str]) -> list[dict]:
    results: list[dict] = []
    incomplete_by_ref = {item["ref"]: item for item in detail.get("non_ppm_incomplete", [])}
    for ref in sorted(PHASE1_REFS):
        if ref in applied:
            results.append({"phase": 1, "ref": ref, "status": "skipped", "reason": "already applied"})
            continue
        item = incomplete_by_ref.get(ref)
        if not item:
            results.append({"phase": 1, "ref": ref, "status": "failed", "reason": "not in review data"})
            continue
        job = fetch_job(client, job_id=item["job_id"])
        if not job:
            results.append({"phase": 1, "ref": ref, "status": "failed", "reason": "job not found"})
            continue
        preferred = resource_short_name(item["resource"])
        result = build_recommendation(client, job, rules, preferred_resource=preferred)
        if isinstance(result, tuple):
            results.append({"phase": 1, "ref": ref, "status": "failed", "reason": result[1]})
            continue
        record = apply_recommendation(
            client,
            result,
            int(job["JobId"]),
            mode="incomplete_reschedule",
            original_date=item.get("planned"),
        )
        applied.add(ref)
        results.append({"phase": 1, "ref": ref, "status": "applied", **record})
        print(f"Phase 1 applied: {ref} -> {result.proposed_resource} {result.proposed_date} {result.proposed_start}-{result.proposed_end}")
    return results


def run_allocate_phases(
    client: BigChangeClient,
    rules: dict,
    detail: dict,
    applied: set[str],
    min_confidence: str,
) -> list[dict]:
    confidence_order = {"High": 0, "Medium": 1, "Low": 2}
    min_level = confidence_order[min_confidence]
    results: list[dict] = []
    ready = detail.get("ready_to_allocate", [])
    unallocated = {str(j.get("Ref") or ""): j for j in fetch_unallocated_jobs(client)}
    for item in ready:
        ref = item["ref"]
        conf = item.get("confidence", "Low")
        if confidence_order.get(conf, 99) > min_level:
            continue
        if ref in applied:
            results.append({"phase": "allocate", "ref": ref, "status": "skipped", "reason": "already applied"})
            continue
        job = unallocated.get(ref) or fetch_job(client, job_ref=ref)
        if not job:
            results.append({"phase": "allocate", "ref": ref, "status": "failed", "reason": "job not found or already scheduled"})
            continue
        if str(job.get("Resource") or "").strip() and str(job.get("PlannedStart") or "").strip() not in ("", "0001-01-01 00:00:00"):
            results.append({"phase": "allocate", "ref": ref, "status": "skipped", "reason": "already allocated"})
            applied.add(ref)
            continue
        preferred = resource_short_name(item["proposed_resource"]) if item.get("proposed_resource") else None
        result = build_recommendation(client, job, rules, preferred_resource=preferred)
        if isinstance(result, tuple):
            results.append({"phase": "allocate", "ref": ref, "confidence": conf, "status": "failed", "reason": result[1]})
            continue
        mode = f"batch_apply_{conf.lower()}"
        record = apply_recommendation(client, result, int(job["JobId"]), mode=mode)
        applied.add(ref)
        results.append({"phase": "allocate", "ref": ref, "confidence": conf, "status": "applied", **record})
        print(f"Allocated ({conf}): {ref} -> {result.proposed_resource} {result.proposed_date} {result.proposed_start}-{result.proposed_end}")
    return results


def main() -> int:
    detail = load_detail()
    applied = load_applied_refs()
    rules = load_rules()
    client = BigChangeClient()

    all_results: list[dict] = []
    print("=== Phase 1: Reschedule incomplete non-PPM (7 jobs) ===")
    all_results.extend(run_phase1(client, rules, detail, applied))

    print("\n=== Phase 2: Allocate High-confidence unscheduled ===")
    all_results.extend(run_allocate_phases(client, rules, detail, applied, "High"))

    print("\n=== Phase 3: Allocate Medium-confidence unscheduled ===")
    all_results.extend(run_allocate_phases(client, rules, detail, applied, "Medium"))

    print("\n=== Phase 4: Allocate Low-confidence (with caution) ===")
    all_results.extend(run_allocate_phases(client, rules, detail, applied, "Low"))

    summary = {
        "executed_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "applied": sum(1 for r in all_results if r.get("status") == "applied"),
        "failed": sum(1 for r in all_results if r.get("status") == "failed"),
        "skipped": sum(1 for r in all_results if r.get("status") == "skipped"),
        "results": all_results,
    }
    RESULT_PATH.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"\n=== Summary: {summary['applied']} applied, {summary['failed']} failed, {summary['skipped']} skipped ===")
    print(json.dumps({k: v for k, v in summary.items() if k != "results"}, indent=2))
    return 0 if summary["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
