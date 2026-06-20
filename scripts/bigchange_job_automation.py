#!/usr/bin/env python3
"""BigChange job maintenance automation.

The script reviews jobs created in the last N days, generates a preview of
intended updates, and optionally applies those updates. Credentials are read
from environment variables and are never written to artifacts.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import signal
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


DEFAULT_BASE_URL = "https://webservice.bigchange.com/v01/services.ashx"
AUTO_CLOSE_DOWN = "Auto Close Down"
UNCATEGORISED = "Uncategorised"
FALLBACK_CATEGORY = "Hayley Longford"
INVOICE_CREATED = "InvoiceCreated"
INVOICE_CREATED_STATUS_ID = 34


class BigChangeError(RuntimeError):
    """Raised when a BigChange web service call fails permanently."""


class RequestTimeoutError(TimeoutError):
    """Raised when a web service request exceeds the hard timeout."""


@dataclass(frozen=True)
class IntendedUpdate:
    job_id: int
    job_ref: str
    update_type: str
    reason: str
    params: dict[str, Any]
    before: dict[str, Any]
    target: dict[str, Any]


class BigChangeClient:
    def __init__(self, base_url: str, api_key: str, username: str, password: str, *, timeout_seconds: int) -> None:
        self.base_url = base_url
        self.api_key = api_key
        self.timeout_seconds = timeout_seconds
        auth = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
        self.headers = {
            "Authorization": f"Basic {auth}",
            "User-Agent": "cursor-bigchange-automation/1.0",
        }

    @staticmethod
    def _timeout_handler(_signum: int, _frame: Any) -> None:
        raise RequestTimeoutError("request exceeded hard timeout")

    def call(
        self,
        params: dict[str, Any],
        *,
        expected_code_zero: bool = True,
        max_attempts: int = 5,
    ) -> Any:
        query = {"key": self.api_key}
        query.update({k: v for k, v in params.items() if v is not None})
        encoded = urllib.parse.urlencode(query)
        url = f"{self.base_url}?{encoded}"

        last_error: Exception | None = None
        for attempt in range(max_attempts):
            try:
                request = urllib.request.Request(url, headers=self.headers)
                old_handler = signal.signal(signal.SIGALRM, self._timeout_handler)
                signal.alarm(self.timeout_seconds + 5)
                try:
                    with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                        raw = response.read().decode("utf-8", "replace")
                finally:
                    signal.alarm(0)
                    signal.signal(signal.SIGALRM, old_handler)
                payload = json.loads(raw)

                if isinstance(payload, dict) and payload.get("Code") == 3:
                    raise BigChangeError(f"BigChange server error: {payload.get('Result')}")
                if expected_code_zero and isinstance(payload, dict) and payload.get("Code") != 0:
                    raise BigChangeError(f"BigChange returned Code={payload.get('Code')}: {payload.get('Result')}")
                return payload
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, BigChangeError, json.JSONDecodeError) as exc:
                last_error = exc
                retryable_http = isinstance(exc, urllib.error.HTTPError) and exc.code in {429, 500, 502, 503, 504}
                retryable = retryable_http or isinstance(exc, (urllib.error.URLError, TimeoutError, json.JSONDecodeError))
                retryable = retryable or (isinstance(exc, BigChangeError) and "server error" in str(exc).lower())
                if not retryable or attempt == max_attempts - 1:
                    break
                time.sleep(2**attempt)

        raise BigChangeError(str(last_error))


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"Missing required environment variable: {name}")
    return value


def parse_bigchange_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    text = str(value).strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(text[:19], fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def parse_cli_datetime(value: str, *, end_of_day: bool = False) -> datetime:
    text = value.strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            parsed = datetime.strptime(text, fmt).replace(tzinfo=timezone.utc)
            if fmt == "%Y-%m-%d" and end_of_day:
                parsed = parsed.replace(hour=23, minute=59, second=59)
            return parsed
        except ValueError:
            continue
    raise SystemExit(f"Invalid date/datetime: {value!r}")


def default_window(now: datetime, days: int) -> tuple[datetime, datetime]:
    return now - timedelta(days=days), now


def in_window(job: dict[str, Any], start_dt: datetime, end_dt: datetime) -> bool:
    created = parse_bigchange_datetime(job.get("Created"))
    return bool(created and start_dt <= created <= end_dt)


def future_date_fields(job: dict[str, Any], cutoff_dt: datetime) -> list[str]:
    fields = []
    for field in ("PlannedStart", "PlannedEnd", "DueDate"):
        value = parse_bigchange_datetime(job.get(field))
        if value and value > cutoff_dt:
            fields.append(field)
    return fields


def normalise_name(value: Any) -> str:
    return " ".join(str(value or "").strip().split()).casefold()


def is_uncategorised(job: dict[str, Any]) -> bool:
    category = job.get("Category")
    return category is None or not str(category).strip() or normalise_name(category) == normalise_name(UNCATEGORISED)


def is_actioned(job: dict[str, Any]) -> bool:
    return normalise_name(job.get("Actioned")) == "yes"


def result_list(response: Any, action: str) -> list[Any]:
    if not isinstance(response, dict) or response.get("Code") != 0:
        raise BigChangeError(f"{action} did not return a successful service result")
    result = response.get("Result")
    if result in (None, "No results"):
        return []
    if not isinstance(result, list):
        raise BigChangeError(f"{action} returned unexpected result type: {type(result).__name__}")
    return result


def fetch_paged_jobs(client: BigChangeClient, start: str, end: str, *, page_size: int, tag_id: int | None = None) -> list[dict[str, Any]]:
    jobs: list[dict[str, Any]] = []
    page = 0
    while True:
        params: dict[str, Any] = {
            "action": "JobsList",
            "start": start,
            "end": end,
            "dateOptionId": 2,  # CreationDate, per Dateoptions service/PDF.
            "includeTime": 1,
            "page": page,
            "pageSize": page_size,
            "actioned": 1,
            "unactioned": 1,
            "allocated": 1,
            "unallocated": 1,
            "includeExtra": 1,
        }
        if tag_id is not None:
            params["tagId"] = str(tag_id)
        response = client.call(params)
        items = result_list(response, "JobsList")
        jobs.extend(items)
        if len(items) < page_size:
            break
        page += 1
    return jobs


def first_creator_from_history(history: list[dict[str, Any]]) -> tuple[str | None, str]:
    if not history:
        return None, "no status history entries"

    def sort_key(row: dict[str, Any]) -> tuple[datetime, int]:
        parsed = parse_bigchange_datetime(row.get("JobStatusDate")) or datetime.max.replace(tzinfo=timezone.utc)
        return parsed, int(row.get("JobStatusRowId") or 0)

    ordered = sorted(history, key=sort_key)
    for row in ordered:
        if normalise_name(row.get("JobStatus")) == "new" and row.get("JobStatusOwner"):
            return str(row["JobStatusOwner"]).strip(), "first New status owner"
    for row in ordered:
        if row.get("JobStatusOwner"):
            return str(row["JobStatusOwner"]).strip(), "earliest status owner"
    return None, "status history did not include an owner"


def has_invoice_created(activity: list[dict[str, Any]]) -> bool:
    return any(normalise_name(row.get("JobClientStatus")) == normalise_name(INVOICE_CREATED) for row in activity)


def write_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def append_log(path: Path, row: dict[str, Any]) -> None:
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, sort_keys=True, default=str) + "\n")


def existing_apply_keys(path: Path) -> set[tuple[int, str]]:
    keys: set[tuple[int, str]] = set()
    if not path.exists():
        return keys
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("status") == "updated":
                keys.add((int(row["job_id"]), str(row["update_type"])))
    return keys


def build_summary(
    *,
    run_started: str,
    run_finished: str,
    dry_run: bool,
    total_jobs: int,
    reviewed_rows: list[dict[str, Any]],
    intended_updates: list[IntendedUpdate],
    apply_results: list[dict[str, Any]],
    report_path: Path,
) -> None:
    jobs_with_intended = {u.job_id for u in intended_updates}
    jobs_with_success = {r["job_id"] for r in apply_results if r.get("status") == "updated"}
    jobs_with_failure = {r["job_id"] for r in apply_results if r.get("status") == "failed"}
    operation_success_count = sum(1 for r in apply_results if r.get("status") == "updated")
    operation_failure_count = sum(1 for r in apply_results if r.get("status") == "failed")
    skip_reasons: Counter[str] = Counter()
    failure_reasons: Counter[str] = Counter()

    for row in reviewed_rows:
        for reason in row.get("skip_reasons", []):
            skip_reasons[reason] += 1
    for row in apply_results:
        if row.get("status") == "failed":
            failure_reasons[row.get("error", "unknown failure")] += 1

    lines = [
        "# BigChange job automation summary",
        "",
        f"- Run started: {run_started}",
        f"- Run finished: {run_finished}",
        f"- Mode: {'dry-run preview only' if dry_run else 'applied updates'}",
        f"- Total jobs reviewed: {total_jobs}",
        f"- Total jobs with intended updates in preview: {len(jobs_with_intended)}",
        f"- Total updated: {len(jobs_with_success) if not dry_run else 0}",
        f"- Total skipped: {total_jobs - len(jobs_with_intended)}",
        f"- Total failed: {len(jobs_with_failure) if not dry_run else 0}",
        f"- Update operations succeeded: {operation_success_count if not dry_run else 0}",
        f"- Update operations failed: {operation_failure_count if not dry_run else 0}",
        "",
        "## Intended update operations",
        "",
    ]

    update_counts = Counter(update.update_type for update in intended_updates)
    if update_counts:
        for name, count in sorted(update_counts.items()):
            lines.append(f"- {name}: {count}")
    else:
        lines.append("- None")

    lines.extend(["", "## Skip reasons", ""])
    if skip_reasons:
        for reason, count in skip_reasons.most_common():
            lines.append(f"- {reason}: {count}")
    else:
        lines.append("- None")

    lines.extend(["", "## Failure reasons", ""])
    if failure_reasons:
        for reason, count in failure_reasons.most_common():
            lines.append(f"- {reason}: {count}")
    else:
        lines.append("- None")

    report_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def run(args: argparse.Namespace) -> int:
    run_started_dt = datetime.now(timezone.utc)
    run_started = run_started_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    default_start_dt, default_end_dt = default_window(run_started_dt, args.days)
    start_dt = parse_cli_datetime(args.start_date) if args.start_date else default_start_dt
    end_dt = parse_cli_datetime(args.end_date, end_of_day=True) if args.end_date else default_end_dt
    start = start_dt.strftime("%Y-%m-%d %H:%M:%S")
    end = end_dt.strftime("%Y-%m-%d %H:%M:%S")

    output_dir = Path(args.output_dir or f"runs/bigchange_{run_started_dt.strftime('%Y%m%dT%H%M%SZ')}")
    output_dir.mkdir(parents=True, exist_ok=True)
    review_log_path = output_dir / "review_log.jsonl"
    preview_path = output_dir / "preview_updates.json"
    apply_results_path = output_dir / "apply_results.json"
    apply_results_jsonl_path = output_dir / "apply_results.jsonl"
    summary_path = output_dir / "summary_report.md"
    for path in (review_log_path,):
        path.write_text("", encoding="utf-8")

    client = BigChangeClient(
        os.environ.get("BIGCHANGE_BASE_URL", DEFAULT_BASE_URL),
        require_env("BIGCHANGE_API_KEY"),
        require_env("BIGCHANGE_USERNAME"),
        require_env("BIGCHANGE_PASSWORD"),
        timeout_seconds=args.timeout_seconds,
    )

    categories = result_list(client.call({"action": "JobCategories"}), "JobCategories")
    category_by_name = {normalise_name(row.get("label")): row for row in categories if row.get("label")}
    fallback_category = category_by_name.get(normalise_name(FALLBACK_CATEGORY))

    tags = result_list(client.call({"action": "Tags"}), "Tags")
    auto_close_tags = [
        row
        for row in tags
        if normalise_name(row.get("tagName")) == normalise_name(AUTO_CLOSE_DOWN)
        and normalise_name(row.get("type")) == "job"
    ]
    if not auto_close_tags:
        raise BigChangeError('Could not confirm a Job tag named "Auto Close Down"')
    auto_close_tag_id = int(auto_close_tags[0]["Id"])

    all_jobs = fetch_paged_jobs(client, start, end, page_size=args.page_size)
    excluded_future_jobs: dict[int, list[str]] = {}

    def in_scope(job: dict[str, Any]) -> bool:
        if not job.get("JobId") or not in_window(job, start_dt, end_dt):
            return False
        if args.exclude_future_dated:
            fields = future_date_fields(job, end_dt)
            if fields:
                excluded_future_jobs[int(job["JobId"])] = fields
                return False
        return True

    jobs_by_id: dict[int, dict[str, Any]] = {int(job["JobId"]): job for job in all_jobs if in_scope(job)}
    flagged_jobs = fetch_paged_jobs(client, start, end, page_size=args.page_size, tag_id=auto_close_tag_id)
    flagged_ids = {int(job["JobId"]) for job in flagged_jobs if in_scope(job)}
    for job in flagged_jobs:
        if in_scope(job):
            jobs_by_id.setdefault(int(job["JobId"]), job)

    intended: list[IntendedUpdate] = []
    reviewed_rows: list[dict[str, Any]] = []

    for job_id in sorted(jobs_by_id):
        job = jobs_by_id[job_id]
        ref = str(job.get("Ref") or "")
        skip_reasons: list[str] = []
        intended_types: list[str] = []

        if is_uncategorised(job):
            try:
                history = result_list(client.call({"action": "JobStatusHistory", "jobId": job_id}), "JobStatusHistory")
                creator, source = first_creator_from_history(history)
                matching_category = category_by_name.get(normalise_name(creator)) if creator else None
                target_category = matching_category or (fallback_category if creator else None)
                if creator and target_category:
                    if matching_category:
                        reason = f"uncategorised job; creator from {source} matches an existing category"
                    else:
                        reason = (
                            f"uncategorised job; creator from {source} has no matching category; "
                            f"using confirmed fallback category {FALLBACK_CATEGORY}"
                        )
                    intended.append(
                        IntendedUpdate(
                            job_id=job_id,
                            job_ref=ref,
                            update_type="job_category",
                            reason=reason,
                            params={
                                "action": "JobSave",
                                "JobId": job_id,
                                "JobCategory": target_category["label"],
                                "PreserveSchedule": 1,
                            },
                            before={"Category": job.get("Category"), "JobCategoryId": job.get("JobCategoryId")},
                            target={
                                "Category": target_category["label"],
                                "JobCategoryId": target_category.get("id"),
                                "creator": creator,
                                "creatorCategoryMatched": bool(matching_category),
                            },
                        )
                    )
                    intended_types.append("job_category")
                else:
                    if creator:
                        skip_reasons.append(
                            f"uncategorised but no matching category for creator and fallback missing: {creator}"
                        )
                    else:
                        skip_reasons.append(f"uncategorised but creator could not be identified: {source}")
            except Exception as exc:  # noqa: BLE001 - keep processing remaining jobs.
                skip_reasons.append(f"failed to inspect creator history: {exc}")
        else:
            skip_reasons.append("valid existing job category")

        if job_id in flagged_ids:
            try:
                activity = result_list(client.call({"action": "JobCustomerActivity", "jobId": job_id}), "JobCustomerActivity")
                invoice_created = has_invoice_created(activity)
                if is_actioned(job) and invoice_created:
                    skip_reasons.append("Auto Close Down already actioned with InvoiceCreated status")
                else:
                    if not is_actioned(job):
                        intended.append(
                            IntendedUpdate(
                                job_id=job_id,
                                job_ref=ref,
                                update_type="auto_close_actioned",
                                reason="Auto Close Down flag confirmed; mark job as actioned",
                                params={
                                    "action": "JobSaveBackOfficeNote",
                                    "jobId": job_id,
                                    "actioned": 1,
                                    "note": "Automated Auto Close Down actioned update",
                                },
                                before={"Actioned": job.get("Actioned"), "CurrentFlag": job.get("CurrentFlag")},
                                target={"Actioned": "Yes"},
                            )
                        )
                        intended_types.append("auto_close_actioned")
                    else:
                        skip_reasons.append("Auto Close Down already actioned")
                    if not invoice_created:
                        intended.append(
                            IntendedUpdate(
                                job_id=job_id,
                                job_ref=ref,
                                update_type="auto_close_invoice_created",
                                reason="Auto Close Down flag confirmed; set invoice status InvoiceCreated",
                                params={
                                    "action": "JobClientStatus",
                                    "JobId": job_id,
                                    "JobClientStatus": INVOICE_CREATED_STATUS_ID,
                                    "Comment": "Automated Auto Close Down invoice status update",
                                },
                                before={
                                    "Actioned": job.get("Actioned"),
                                    "InvoiceCreated": invoice_created,
                                    "CurrentFlag": job.get("CurrentFlag"),
                                },
                                target={
                                    "JobClientStatus": INVOICE_CREATED,
                                    "JobClientStatusID": INVOICE_CREATED_STATUS_ID,
                                },
                            )
                        )
                        intended_types.append("auto_close_invoice_created")
                    else:
                        skip_reasons.append("Auto Close Down already has InvoiceCreated status")
            except Exception as exc:  # noqa: BLE001 - keep processing remaining jobs.
                skip_reasons.append(f"failed to inspect customer activity: {exc}")
        else:
            skip_reasons.append("Auto Close Down flag not present")

        row = {
            "job_id": job_id,
            "job_ref": ref,
            "created": job.get("Created"),
            "category": job.get("Category"),
            "actioned": job.get("Actioned"),
            "current_flag": job.get("CurrentFlag"),
            "review_status": "update_previewed" if intended_types else "skipped",
            "intended_update_types": intended_types,
            "skip_reasons": skip_reasons,
        }
        reviewed_rows.append(row)
        append_log(review_log_path, row)

    preview_payload = {
        "run_started": run_started,
        "window": {
            "days": args.days,
            "start": start,
            "end": end,
            "dateOptionId": 2,
            "excludeFutureDated": args.exclude_future_dated,
            "futureDateFields": ["PlannedStart", "PlannedEnd", "DueDate"] if args.exclude_future_dated else [],
        },
        "confirmed_references": {
            "autoCloseDownTagId": auto_close_tag_id,
            "fallbackCategoryId": fallback_category.get("id") if fallback_category else None,
            "fallbackCategoryName": fallback_category.get("label") if fallback_category else None,
            "invoiceCreatedClientStatusId": INVOICE_CREATED_STATUS_ID,
        },
        "jobs_excluded_as_future_dated": len(excluded_future_jobs),
        "total_jobs_reviewed": len(jobs_by_id),
        "updates": [
            {
                "job_id": update.job_id,
                "job_ref": update.job_ref,
                "update_type": update.update_type,
                "reason": update.reason,
                "before": update.before,
                "target": update.target,
            }
            for update in intended
        ],
    }
    write_json(preview_path, preview_payload)

    apply_results: list[dict[str, Any]] = []
    if args.apply:
        completed = existing_apply_keys(apply_results_jsonl_path) if args.resume else set()
        for update in intended:
            key = (update.job_id, update.update_type)
            if key in completed:
                continue
            try:
                response = client.call(update.params)
                result = {
                    "job_id": update.job_id,
                    "job_ref": update.job_ref,
                    "update_type": update.update_type,
                    "status": "updated",
                    "response": response,
                }
            except Exception as exc:  # noqa: BLE001 - keep processing remaining jobs.
                result = {
                    "job_id": update.job_id,
                    "job_ref": update.job_ref,
                    "update_type": update.update_type,
                    "status": "failed",
                    "error": str(exc),
                }
            apply_results.append(result)
            append_log(apply_results_jsonl_path, result)
    write_json(apply_results_path, apply_results)

    run_finished = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    build_summary(
        run_started=run_started,
        run_finished=run_finished,
        dry_run=not args.apply,
        total_jobs=len(jobs_by_id),
        reviewed_rows=reviewed_rows,
        intended_updates=intended,
        apply_results=apply_results,
        report_path=summary_path,
    )

    print(f"review_log={review_log_path}")
    print(f"preview={preview_path}")
    print(f"apply_results={apply_results_path}")
    print(f"apply_results_jsonl={apply_results_jsonl_path}")
    print(f"summary={summary_path}")
    print(f"jobs_excluded_as_future_dated={len(excluded_future_jobs)}")
    print(f"jobs_reviewed={len(jobs_by_id)} intended_updates={len(intended)} applied={len(apply_results)}")
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Apply previewed updates after generating the preview.")
    parser.add_argument("--days", type=int, default=30, help="Look back this many days from the run start time.")
    parser.add_argument("--start-date", help="Override inclusive creation-date window start (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS).")
    parser.add_argument("--end-date", help="Override inclusive creation-date window end (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS).")
    parser.add_argument("--page-size", type=int, default=5000, help="JobsList page size.")
    parser.add_argument(
        "--exclude-future-dated",
        action="store_true",
        help="Exclude jobs with PlannedStart, PlannedEnd, or DueDate after the window end.",
    )
    parser.add_argument("--resume", action="store_true", help="Skip updates already marked successful in apply_results.jsonl.")
    parser.add_argument("--timeout-seconds", type=int, default=30, help="Per-request socket timeout.")
    parser.add_argument("--output-dir", help="Directory for preview, logs, and summary artifacts.")
    return parser.parse_args(argv)


if __name__ == "__main__":
    raise SystemExit(run(parse_args(sys.argv[1:])))
