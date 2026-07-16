#!/usr/bin/env python3
"""Confirm upcoming Dandara FixFlo appointments from BigChange schedules."""

from __future__ import annotations

import base64
import csv
import datetime as dt
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable
from zoneinfo import ZoneInfo


IS_RE = re.compile(r"\bIS\d{8}\b", re.IGNORECASE)
OPEN_FIXFLO_STATUSES = {"reported", "jobawarded", "awaitingjobcompletion"}
OPEN_BIGCHANGE_STATUS_IDS = "1|2|3|4|5|6|7|8|9|10|11"
CONFIRMATION_PHRASES = ("confirm your appointment", "quick note to confirm", "appointment on")
MESSAGE_TEMPLATE = (
    "Hi,\n"
    "Just a quick note to confirm your appointment on {date}, between 8:00 am and 5:00 pm.\n"
    "Please let us know if this still works for you or if you need to rearrange."
)
ISSUE_REFERENCE_FIELDS = ("JobPO", "JobGroup", "Description", "CustNote", "ResNote", "StatusComment")
BIGCHANGE_DANDARA_FIELDS = (
    "JobGroup",
    "Description",
    "CustNote",
    "ResNote",
    "Location",
    "Contact",
    "PrintName",
    "Postcode",
)
SITE_ALIASES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("Leodis Square, Leeds", ("leodis square", "aaron house", "burton house", "calvert house", "daniels house")),
    (
        "Chapel Wharf, Salford",
        ("chapel wharf", "alcock house", "bradshaw house", "chapman house", "doodson house"),
    ),
    ("The Point, Aberdeen", ("the point, aberdeen", "the point aberdeen")),
    ("Stoneywood Brae, Aberdeen / Dyce", ("stoneywood brae",)),
    ("Granary Quay, Glasgow", ("granary quay",)),
    ("Aston Place, Birmingham", ("aston place",)),
)


class ConfigError(RuntimeError):
    """Raised when required runtime configuration is absent."""


def required_env(name: str) -> str:
    value = os.environ.get(name)
    if value in (None, ""):
        raise ConfigError(f"Missing required environment variable: {name}")
    return value


def optional_env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def truthy(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "y"}


def compact(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def parse_datetime(value: Any) -> dt.datetime | None:
    if value in (None, "", "0001-01-01 00:00:00"):
        return None
    text = str(value).strip()
    for fmt in (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d",
        "%d/%m/%Y %H:%M:%S",
        "%d/%m/%Y %H:%M",
        "%d/%m/%Y",
    ):
        try:
            return dt.datetime.strptime(text, fmt)
        except ValueError:
            continue
    try:
        parsed = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=None)
    except ValueError:
        return None


def nested_strings(value: Any) -> Iterable[str]:
    if isinstance(value, dict):
        for nested in value.values():
            yield from nested_strings(nested)
    elif isinstance(value, (list, tuple, set)):
        for nested in value:
            yield from nested_strings(nested)
    elif value not in (None, ""):
        yield str(value)


def row_text(row: dict[str, Any], fields: Iterable[str]) -> str:
    return " ".join(str(row.get(field, "")) for field in fields if row.get(field) not in (None, ""))


def extract_issue_ids(row: dict[str, Any]) -> list[str]:
    return sorted({match.upper() for match in IS_RE.findall(row_text(row, ISSUE_REFERENCE_FIELDS))})


def identify_site(*texts: str, explicit_dandara: bool = False) -> str:
    normalized = " ".join(texts).lower()
    for site_name, aliases in SITE_ALIASES:
        if any(alias in normalized for alias in aliases):
            return site_name
    if "the point" in normalized and ("aberdeen" in normalized or explicit_dandara):
        return "The Point, Aberdeen"
    if "armouries" in normalized and explicit_dandara:
        return "Armouries, Birmingham"
    return ""


def assigned_agent_email(issue: dict[str, Any]) -> str:
    agent = issue.get("AssignedAgent")
    return str(agent.get("EmailAddress", "")) if isinstance(agent, dict) else ""


def classify_dandara(row: dict[str, Any], issue: dict[str, Any]) -> tuple[bool, str]:
    bc_text = row_text(row, BIGCHANGE_DANDARA_FIELDS)
    issue_text = " ".join(nested_strings(issue))
    group_text = str(row.get("JobGroup", ""))
    explicit = (
        "dandara" in group_text.lower()
        or "dandara" in assigned_agent_email(issue).lower()
        or "dandara" in issue_text.lower()
    )
    site = identify_site(bc_text, issue_text, explicit_dandara=explicit)
    return explicit or bool(site), site or ("Dandara (site unspecified)" if explicit else "")


def fixflo_job_id(issue: dict[str, Any]) -> str:
    job = issue.get("Job")
    if not isinstance(job, dict):
        return ""
    job_id = str(job.get("Id", "")).strip().upper()
    return job_id if job_id.startswith("JB") else ""


def choose_recipient(issue: dict[str, Any]) -> str:
    tenant_id = str(issue.get("TenantId", "") or "").strip()
    if tenant_id and truthy(issue.get("TenantPresenceRequested")):
        return "Tenant"
    return "Agent"


def is_confirmation_for_date(comment: dict[str, Any], date_text: str) -> bool:
    message = str(comment.get("Message", ""))
    lowered = message.lower()
    return date_text in message and any(phrase in lowered for phrase in CONFIRMATION_PHRASES)


def normalize_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    result = payload.get("Result")
    if isinstance(result, list):
        return [row for row in result if isinstance(row, dict)]
    if isinstance(result, dict):
        for value in result.values():
            if isinstance(value, list):
                return [row for row in value if isinstance(row, dict)]
        return [result]
    return []


def error_description(exc: BaseException) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        return f"HTTP {exc.code}"
    return type(exc).__name__


class JsonHttpClient:
    def request_json(
        self,
        request: urllib.request.Request,
        *,
        timeout: int = 60,
        attempts: int = 4,
    ) -> Any:
        last_error: BaseException | None = None
        for attempt in range(attempts):
            try:
                with urllib.request.urlopen(request, timeout=timeout) as response:
                    raw = response.read()
                return json.loads(raw.decode("utf-8-sig")) if raw else {}
            except urllib.error.HTTPError as exc:
                last_error = exc
                retryable = exc.code == 429 or 500 <= exc.code < 600
                if not retryable or attempt == attempts - 1:
                    break
                retry_after = exc.headers.get("Retry-After")
                try:
                    delay = float(retry_after) if retry_after else float(2**attempt)
                except ValueError:
                    delay = float(2**attempt)
                time.sleep(delay)
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
                last_error = exc
                if attempt == attempts - 1:
                    break
                time.sleep(float(2**attempt))
        assert last_error is not None
        raise RuntimeError(error_description(last_error)) from last_error


class BigChangeClient(JsonHttpClient):
    def __init__(self) -> None:
        if optional_env("BIGCHANGE_AUTH_MODE", "api_key").strip().lower() != "api_key":
            raise ConfigError("BIGCHANGE_AUTH_MODE must be api_key")
        self.base_url = required_env("BIGCHANGE_BASE_URL")
        username = required_env("BIGCHANGE_USERNAME")
        password = required_env("BIGCHANGE_PASSWORD")
        token = base64.b64encode(f"{username}:{password}".encode()).decode()
        self.headers = {
            "Authorization": f"Basic {token}",
            "key": required_env("BIGCHANGE_API_KEY"),
            "Accept": "application/json",
        }

    def jobs(self, start: dt.date, end: dt.date, page_size: int = 500) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        page = 0
        while True:
            query = urllib.parse.urlencode(
                {
                    "action": "JobsList",
                    "Start": start.isoformat(),
                    "End": end.isoformat(),
                    "DateOptionId": 4,
                    "StatusId": OPEN_BIGCHANGE_STATUS_IDS,
                    "Page": page,
                    "PageSize": page_size,
                }
            )
            request = urllib.request.Request(f"{self.base_url}?{query}", headers=self.headers)
            payload = self.request_json(request, timeout=90)
            if not isinstance(payload, dict) or payload.get("Code") not in (None, "", 0, "0"):
                code = payload.get("Code") if isinstance(payload, dict) else "invalid response"
                raise RuntimeError(f"BigChange JobsList failed: {code}")
            batch = normalize_rows(payload)
            rows.extend(batch)
            if len(batch) < page_size:
                return rows
            page += 1
            if page > 100:
                raise RuntimeError("BigChange JobsList exceeded pagination safety limit")


class FixFloClient(JsonHttpClient):
    def __init__(self) -> None:
        self.base_url = required_env("FIXFLO_BASE_URL").rstrip("/")
        self.headers = {
            "Authorization": f"Bearer {required_env('FIXFLO_API_KEY')}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

    def get_issue(self, issue_id: str) -> dict[str, Any]:
        request = urllib.request.Request(f"{self.base_url}/issue/{urllib.parse.quote(issue_id)}", headers=self.headers)
        payload = self.request_json(request)
        if not isinstance(payload, dict):
            raise RuntimeError("unexpected FixFlo issue response")
        return payload

    def get_comments(self, issue_id: str) -> list[dict[str, Any]]:
        url = f"{self.base_url}/issue/{urllib.parse.quote(issue_id)}/comments"
        comments: list[dict[str, Any]] = []
        pages = 0
        while url:
            request = urllib.request.Request(url, headers=self.headers)
            payload = self.request_json(request)
            if isinstance(payload, list):
                comments.extend(item for item in payload if isinstance(item, dict))
                return comments
            if not isinstance(payload, dict):
                raise RuntimeError("unexpected FixFlo comments response")
            items = payload.get("Items", [])
            if isinstance(items, list):
                comments.extend(item for item in items if isinstance(item, dict))
            next_url = str(payload.get("NextURL", "") or "")
            url = urllib.parse.urljoin(f"{self.base_url}/", next_url) if next_url else ""
            pages += 1
            if pages > 100:
                raise RuntimeError("FixFlo comments exceeded pagination safety limit")
        return comments

    def post_comment(self, issue_id: str, date_text: str, recipient: str) -> dict[str, Any]:
        payload = {
            "Message": MESSAGE_TEMPLATE.format(date=date_text),
            "CommentToEntityType": [recipient],
        }
        request = urllib.request.Request(
            f"{self.base_url}/issue/{urllib.parse.quote(issue_id)}/comment",
            data=json.dumps(payload).encode(),
            headers=self.headers,
            method="POST",
        )
        response = self.request_json(request)
        if not isinstance(response, dict):
            raise RuntimeError("unexpected FixFlo comment response")
        return response


def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": 1, "issues": {}}
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Could not load confirmation state: {error_description(exc)}") from exc
    if not isinstance(state, dict) or not isinstance(state.get("issues", {}), dict):
        raise RuntimeError("Confirmation state has an invalid structure")
    state.setdefault("version", 1)
    state.setdefault("issues", {})
    return state


def atomic_json_write(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
        temporary = Path(handle.name)
    temporary.replace(path)


def write_candidates(path: Path, candidates: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = ["site", "issue_id", "job_id", "bigchange_ref", "planned_start", "recipient"]
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for candidate in candidates:
            writer.writerow({field: candidate.get(field, "") for field in fields})


def state_entry(
    *,
    issue_id: str,
    recipient: str,
    confirmed_date: str,
    comment_id: Any,
    sent_at: str,
    site_name: str,
) -> dict[str, Any]:
    return {
        "issue_id": issue_id,
        "recipient": recipient,
        "confirmed_date": confirmed_date,
        "comment_id": comment_id,
        "sent_at": sent_at,
        "site_name": site_name,
    }


def run(
    bigchange: Any,
    fixflo: Any,
    *,
    today: dt.date,
    artifacts_dir: Path,
    dry_run: bool = False,
) -> dict[str, Any]:
    end = today + dt.timedelta(days=15)
    state_path = artifacts_dir / "dandara-confirmation-state.json"
    state = load_state(state_path)
    prior_state = dict(state["issues"])
    summary: dict[str, Any] = {
        "window_start": today.isoformat(),
        "window_end": end.isoformat(),
        "bigchange_jobs_with_is": 0,
        "dandara_fixflo_jobs": 0,
        "non_fixflo_skipped": 0,
        "non_dandara_skipped": 0,
        "eligible_open_fixflo_jobs": 0,
        "already_confirmed_same_date": 0,
        "newly_confirmed": 0,
        "rescheduled_and_reconfirmed": 0,
        "recipient_split": {"Tenant": 0, "Agent": 0},
        "site_breakdown": {},
        "failures": [],
    }
    send_results: list[dict[str, Any]] = []

    rows = bigchange.jobs(today, end)
    window_rows: list[tuple[dict[str, Any], dt.date]] = []
    for row in rows:
        planned = parse_datetime(row.get("PlannedStart"))
        if planned is None or not today <= planned.date() <= end:
            continue
        window_rows.append((row, planned.date()))

    raw_candidates: dict[tuple[str, dt.date], list[dict[str, Any]]] = defaultdict(list)
    for row, planned_date in window_rows:
        issue_ids = extract_issue_ids(row)
        if not issue_ids:
            summary["non_fixflo_skipped"] += 1
            continue
        for issue_id in issue_ids:
            raw_candidates[(issue_id, planned_date)].append(row)
    summary["bigchange_jobs_with_is"] = sum(
        1 for row, _planned_date in window_rows if extract_issue_ids(row)
    )

    issue_cache: dict[str, dict[str, Any]] = {}
    eligible: list[dict[str, Any]] = []
    dandara_candidate_count = 0
    for (issue_id, planned_date), grouped_rows in sorted(raw_candidates.items()):
        representative = sorted(grouped_rows, key=lambda row: str(row.get("JobId", "")))[-1]
        classification_row = dict(representative)
        for field in BIGCHANGE_DANDARA_FIELDS:
            classification_row[field] = " ".join(
                str(row.get(field, "")) for row in grouped_rows if row.get(field) not in (None, "")
            )
        try:
            if issue_id not in issue_cache:
                issue_cache[issue_id] = fixflo.get_issue(issue_id)
            issue = issue_cache[issue_id]
        except Exception as exc:
            summary["failures"].append({"issue_id": issue_id, "error": f"FixFlo issue read failed: {exc}"})
            continue
        is_dandara, site_name = classify_dandara(classification_row, issue)
        if not is_dandara:
            summary["non_dandara_skipped"] += 1
            continue
        dandara_candidate_count += 1
        status = compact(issue.get("Status"))
        job_id = fixflo_job_id(issue)
        if status not in OPEN_FIXFLO_STATUSES or not job_id:
            continue
        recipient = choose_recipient(issue)
        bc_refs = sorted(
            {
                str(row.get("Ref") or row.get("JobId") or "").strip()
                for row in grouped_rows
                if row.get("Ref") or row.get("JobId")
            }
        )
        eligible.append(
            {
                "site": site_name,
                "issue_id": issue_id,
                "job_id": job_id,
                "bigchange_ref": "|".join(bc_refs),
                "planned_start": planned_date.strftime("%d/%m/%Y"),
                "planned_date": planned_date,
                "recipient": recipient,
            }
        )

    summary["dandara_fixflo_jobs"] = dandara_candidate_count
    summary["eligible_open_fixflo_jobs"] = len(eligible)
    site_counts = Counter(candidate["site"] for candidate in eligible)
    summary["site_breakdown"] = dict(sorted(site_counts.items()))
    write_candidates(artifacts_dir / "dandara-confirmation-candidates.csv", eligible)

    comments_cache: dict[str, list[dict[str, Any]]] = {}
    prior_dates_by_issue = {
        issue_id: str(entry.get("confirmed_date", ""))
        for issue_id, entry in prior_state.items()
        if isinstance(entry, dict)
    }
    current_dates_by_issue: dict[str, set[str]] = defaultdict(set)
    for candidate in eligible:
        current_dates_by_issue[candidate["issue_id"]].add(candidate["planned_start"])
    reschedule_counted: set[str] = set()

    for candidate in sorted(eligible, key=lambda item: (item["planned_date"], item["issue_id"])):
        issue_id = candidate["issue_id"]
        date_text = candidate["planned_start"]
        recipient = candidate["recipient"]
        existing_state = state["issues"].get(issue_id, {})
        if isinstance(existing_state, dict) and existing_state.get("confirmed_date") == date_text:
            summary["already_confirmed_same_date"] += 1
            send_results.append({"issue_id": issue_id, "date": date_text, "result": "already_confirmed_state"})
            continue

        try:
            if issue_id not in comments_cache:
                comments_cache[issue_id] = fixflo.get_comments(issue_id)
            comments = comments_cache[issue_id]
        except Exception as exc:
            summary["failures"].append({"issue_id": issue_id, "error": f"FixFlo comments read failed: {exc}"})
            send_results.append({"issue_id": issue_id, "date": date_text, "result": "failed_deduplication_check"})
            continue
        existing_comment = next(
            (comment for comment in comments if is_confirmation_for_date(comment, date_text)),
            None,
        )
        if existing_comment is not None:
            summary["already_confirmed_same_date"] += 1
            state["issues"][issue_id] = state_entry(
                issue_id=issue_id,
                recipient=recipient,
                confirmed_date=date_text,
                comment_id=existing_comment.get("Id"),
                sent_at=str(existing_comment.get("CommentSent", "")),
                site_name=candidate["site"],
            )
            send_results.append({"issue_id": issue_id, "date": date_text, "result": "already_confirmed_comment"})
            continue

        previous_date = prior_dates_by_issue.get(issue_id, "")
        is_reschedule = (
            bool(previous_date)
            and previous_date != date_text
            and previous_date not in current_dates_by_issue[issue_id]
            and issue_id not in reschedule_counted
        )
        if dry_run:
            send_results.append(
                {
                    "issue_id": issue_id,
                    "date": date_text,
                    "recipient": recipient,
                    "result": "dry_run_rescheduled" if is_reschedule else "dry_run_new",
                }
            )
            continue
        try:
            response = fixflo.post_comment(issue_id, date_text, recipient)
        except Exception as exc:
            summary["failures"].append({"issue_id": issue_id, "error": f"FixFlo comment send failed: {exc}"})
            send_results.append({"issue_id": issue_id, "date": date_text, "result": "send_failed"})
            continue
        sent_at = dt.datetime.now(dt.timezone.utc).isoformat()
        comment_id = response.get("Id", response.get("CommentId"))
        state["issues"][issue_id] = state_entry(
            issue_id=issue_id,
            recipient=recipient,
            confirmed_date=date_text,
            comment_id=comment_id,
            sent_at=sent_at,
            site_name=candidate["site"],
        )
        summary["newly_confirmed"] += 1
        summary["recipient_split"][recipient] += 1
        if is_reschedule:
            summary["rescheduled_and_reconfirmed"] += 1
            reschedule_counted.add(issue_id)
        result_name = "rescheduled_and_reconfirmed" if is_reschedule else "newly_confirmed"
        send_results.append(
            {
                "issue_id": issue_id,
                "date": date_text,
                "recipient": recipient,
                "comment_id": comment_id,
                "result": result_name,
            }
        )

    run_payload = {
        "run_timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
        "dry_run": dry_run,
        "summary": summary,
        "results": send_results,
    }
    atomic_json_write(artifacts_dir / "dandara-confirmation-results.json", run_payload)
    if not dry_run:
        atomic_json_write(state_path, state)
    return run_payload


def configured_today() -> dt.date:
    override = optional_env("RUN_DATE").strip()
    if override:
        return dt.date.fromisoformat(override)
    timezone = ZoneInfo(optional_env("CONFIRMATION_TIMEZONE", "Europe/London"))
    return dt.datetime.now(timezone).date()


def main() -> int:
    try:
        result = run(
            BigChangeClient(),
            FixFloClient(),
            today=configured_today(),
            artifacts_dir=Path(optional_env("ARTIFACTS_DIR", "artifacts")),
            dry_run=truthy(optional_env("DRY_RUN")),
        )
        print(json.dumps(result["summary"], sort_keys=True))
        return 1 if result["summary"]["failures"] else 0
    except Exception as exc:
        print(json.dumps({"error": str(exc), "failures": 1}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
