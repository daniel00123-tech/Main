#!/usr/bin/env python3
"""BigChange Build-to-Rent job allocation automation (recommendation mode only).

Reviews unallocated BTR jobs and proposes allocation to site-based Tech, CT, or HK
resources. Does not write to BigChange unless explicitly run with --apply (disabled
by default; administrator approval required).
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


DEFAULT_BASE_URL = "https://webservice.bigchange.com/v01/services.ashx"
RULES_PATH = Path("automation-memory/btr-allocation-rules.json")
OPEN_STATUS_IDS = {1, 2, 3, 4, 5, 6, 7, 8, 9, 11}
CLOSED_STATUS_IDS = {10, 12, 13, 14}
JOB_TEXT_FIELDS = (
    "Ref",
    "Type",
    "Category",
    "Contact",
    "Location",
    "Postcode",
    "Description",
    "CurrentFlag",
    "CustNote",
    "ResNote",
    "StatusComment",
    "Status",
)


class ConfigError(RuntimeError):
    pass


@dataclass
class SiteMatch:
    site: str
    method: str
    confidence: str


@dataclass
class RoleMatch:
    role: str
    reason: str
    confidence: str


@dataclass
class ResourceCandidate:
    resource_id: int
    name: str
    role: str
    booked_minutes: int
    job_count: int


@dataclass
class SlotProposal:
    date: dt.date
    start: dt.time
    end: dt.time
    duration_minutes: int
    booking_before: str
    booking_after: str


@dataclass
class Recommendation:
    job_ref: str
    job_id: int
    site: str
    site_identification: str
    description: str
    status: str
    flags: str
    required_role: str
    proposed_resource: str
    proposed_resource_id: int
    proposed_date: str
    proposed_start: str
    proposed_end: str
    duration_minutes: int
    duration_reason: str
    resource_reason: str
    contractor_check: str
    overlap_check: str
    booking_before: str
    booking_after: str
    priority: str
    target_date: str
    confidence: str
    assumptions: list[str] = field(default_factory=list)


def required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise ConfigError(f"Missing required environment variable: {name}")
    return value


def load_rules(path: Path = RULES_PATH) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def normalise(text: Any) -> str:
    return re.sub(r"\s+", " ", str(text or "").strip()).lower()


def parse_datetime(value: Any) -> dt.datetime | None:
    if value in (None, "", "0001-01-01 00:00:00"):
        return None
    text = str(value).strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return dt.datetime.strptime(text[: len(dt.datetime.now().strftime(fmt))], fmt)
        except ValueError:
            continue
    try:
        return dt.datetime.fromisoformat(text.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return None


def parse_duration(value: Any) -> int | None:
    if value in (None, ""):
        return None
    text = str(value).strip()
    match = re.match(r"(\d+):(\d+):(\d+)", text)
    if match:
        hours, minutes, seconds = (int(match.group(i)) for i in range(1, 4))
        total = hours * 60 + minutes + (1 if seconds >= 30 else 0)
        return total if total > 0 else None
    as_int = as_int(value)
    return as_int if as_int and as_int > 0 else None


def as_int(value: Any, default: int | None = None) -> int | None:
    if value in (None, ""):
        return default
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


def job_text(job: dict[str, Any]) -> str:
    return " ".join(normalise(job.get(field, "")) for field in JOB_TEXT_FIELDS)


def identify_site(job: dict[str, Any], rules: dict[str, Any]) -> SiteMatch | None:
    contact = normalise(job.get("Contact"))
    location = normalise(job.get("Location"))
    combined = job_text(job)

    for site, keywords in rules["sites"].items():
        for keyword in keywords:
            keyword_norm = normalise(keyword)
            if keyword_norm in contact or keyword_norm in location:
                return SiteMatch(site=site, method=f"Matched '{keyword}' in contact/location", confidence="High")
        for keyword in keywords:
            keyword_norm = normalise(keyword)
            if keyword_norm and keyword_norm in combined:
                if keyword_norm == "point" and "appoint" in combined:
                    continue
                return SiteMatch(site=site, method=f"Matched '{keyword}' in job metadata", confidence="Medium")
    return None


def contractor_exclusion(job: dict[str, Any], rules: dict[str, Any]) -> tuple[bool, str]:
    text = job_text(job)
    matches = [phrase for phrase in rules["contractor_exclusions"] if phrase in text]
    if matches:
        return True, f"Excluded wording found: {', '.join(sorted(set(matches)))}"
    return False, "No contractor-exclusion wording found"


def is_cleaning_job(job: dict[str, Any]) -> bool:
    description = normalise(job.get("Description"))
    category = normalise(job.get("Category"))
    job_type = normalise(job.get("Type"))
    cleaning_starts = description.startswith("cleaning") or description.startswith("clean ")
    cleaning_terms = (
        "housekeeping",
        "deep clean",
        "remove rubbish and clean",
        "clean communal",
        "clean apartment",
        "clean lift",
        "clean lobby",
    )
    if cleaning_starts:
        return True
    if any(term in description for term in cleaning_terms):
        return True
    if "cleaning" in category or "housekeeping" in category:
        return True
    if "cleaning" in job_type or "housekeeping" in job_type:
        return True
    return False


def determine_role(job: dict[str, Any]) -> RoleMatch:
    if is_cleaning_job(job):
        return RoleMatch(role="HK", reason="Job description/category indicates cleaning or housekeeping work", confidence="High")
    description = normalise(job.get("Description"))
    job_type = normalise(job.get("Type"))
    if any(token in description or token in job_type for token in ("repair", "fault", "leak", "inspect", "maintenance", "call out", "callout", "appliance", "boiler", "door", "lock", "intercom", "immersion", "freezer", "fridge", "washing machine")):
        return RoleMatch(role="Tech", reason="Non-cleaning internal maintenance/technical work", confidence="High")
    if description:
        return RoleMatch(role="Tech", reason="Default to Tech/CT for non-cleaning attendance work", confidence="Medium")
    return RoleMatch(role="", reason="Insufficient information to determine HK vs Tech/CT", confidence="Low")


def resource_role(name: str, rules: dict[str, Any]) -> str | None:
    norm = normalise(name)
    if re.search(r"\bhk\b|_hk\b|_hks\b|hksup", norm):
        return "HK"
    if re.search(r"\bct\b|_ct\b|caretaker", norm):
        return "CT"
    if re.search(r"\btech\b|_tech\b|techsup|sontech", norm):
        return "Tech"
    return None


def resource_site(name: str, rules: dict[str, Any]) -> str | None:
    norm = normalise(name)
    for site, keywords in rules["sites"].items():
        if any(normalise(keyword) in norm for keyword in keywords):
            return site
    return None


def resource_is_excluded(name: str, rules: dict[str, Any]) -> bool:
    norm = normalise(name)
    return any(exclusion in norm for exclusion in rules["resource_exclusions"])


def resource_is_active_for_jobwatch(resource: dict[str, Any]) -> bool:
    """Return True when the resource is active for JobWatch scheduling.

    BigChange exposes this via Resource4Schedule on the Resources list:
      1 = active for JobWatch (can be scheduled)
      0 = inactive (left the business, temp cover ended, etc.)
    """
    return as_int(resource.get("Resource4Schedule"), default=0) == 1


def estimate_duration(job: dict[str, Any], rules: dict[str, Any]) -> tuple[int, str, str]:
    description = normalise(job.get("Description"))
    min_duration = rules["duration_minutes"]["min"]
    max_duration = rules["duration_minutes"]["max"]

    if any(term in description for term in ("deep clean", "multiple apartments", "most of the day", "substantial list")):
        return 240, "Large or multi-area work described", "Medium"
    if any(term in description for term in ("investigation and repair", "several rooms", "multiple tasks", "minor leak", "door or lock", "appliance")):
        return 120, "Investigation/repair or multi-item work likely needs 120 minutes", "Medium"
    if any(term in description for term in ("intercom", "fridge", "freezer", "washing machine", "immersion", "inspection", "adjust", "replace")):
        return 60, "Single straightforward maintenance/appliance attendance", "High"
    existing = parse_duration(job.get("Duration"))
    if existing and existing >= min_duration:
        snapped = min(max_duration, max(min_duration, round(existing / 30) * 30))
        return snapped, f"Used existing planned duration ({existing} min) after minimum-duration rule", "Medium"
    return min_duration, "Default 60 minutes where description gives limited detail", "Low"


def next_working_day(start: dt.date) -> dt.date:
    current = start
    while current.weekday() >= 5:
        current += dt.timedelta(days=1)
    return current


def working_window(day: dt.date) -> tuple[dt.datetime, dt.datetime]:
    start = dt.datetime.combine(day, dt.time(8, 0))
    end = dt.datetime.combine(day, dt.time(17, 0))
    return start, end


def overlaps(start_a: dt.datetime, end_a: dt.datetime, start_b: dt.datetime, end_b: dt.datetime) -> bool:
    return start_a < end_b and end_a > start_b


class BigChangeClient:
    def __init__(self) -> None:
        self.base_url = os.environ.get("BIGCHANGE_BASE_URL", DEFAULT_BASE_URL)
        username = required_env("BIGCHANGE_USERNAME")
        password = required_env("BIGCHANGE_PASSWORD")
        api_key = required_env("BIGCHANGE_API_KEY")
        token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
        self.headers = {
            "Authorization": f"Basic {token}",
            "key": api_key,
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

    def get(self, action: str, params: dict[str, Any] | None = None, attempts: int = 3) -> dict[str, Any]:
        query = {"action": action}
        if params:
            query.update({key: value for key, value in params.items() if value is not None and value != ""})
        url = f"{self.base_url}?{urllib.parse.urlencode(query)}"
        request = urllib.request.Request(url, headers=self.headers)
        last_error: Exception | None = None
        for attempt in range(attempts):
            try:
                with urllib.request.urlopen(request, timeout=60) as response:
                    payload = json.loads(response.read().decode("utf-8-sig"))
                if not isinstance(payload, dict):
                    raise RuntimeError(f"Unexpected response for {action}")
                return payload
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
                last_error = exc
                if attempt == attempts - 1:
                    break
                time.sleep(2**attempt)
        raise RuntimeError(f"BigChange request failed for {action}: {type(last_error).__name__}")

    @staticmethod
    def rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
        result = payload.get("Result")
        if result in (None, "No results"):
            return []
        if isinstance(result, list):
            return [row for row in result if isinstance(row, dict)]
        if isinstance(result, dict):
            return [result]
        return []

    def resources(self) -> list[dict[str, Any]]:
        payload = self.get("Resources")
        if payload.get("Code") not in (0, None):
            raise RuntimeError(f"Resources call failed: {payload.get('Result')}")
        return self.rows(payload)

    def jobs_list(self, params: dict[str, Any], page_size: int = 500) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        page = 0
        while True:
            payload = self.get("JobsList", {**params, "Page": page, "PageSize": page_size})
            if payload.get("Code") not in (0, None):
                raise RuntimeError(f"JobsList failed: {payload.get('Result')}")
            batch = self.rows(payload)
            rows.extend(batch)
            if len(batch) < page_size:
                return rows
            page += 1
            if page > 200:
                raise RuntimeError("JobsList pagination exceeded safety limit")

    def resource_diary(self, resource_id: int, start: dt.date, end: dt.date) -> list[dict[str, Any]]:
        return self.jobs_list(
            {
                "Start": start.isoformat(),
                "End": end.isoformat(),
                "DateOptionId": 0,
                "ResourceId": resource_id,
                "Allocated": 1,
                "ExcludeNullPlannedDates": 1,
            }
        )


def is_unallocated(job: dict[str, Any]) -> bool:
    status_id = as_int(job.get("StatusId"))
    if status_id in CLOSED_STATUS_IDS:
        return False
    resource = normalise(job.get("Resource"))
    if resource and resource not in {"unassigned", "unallocated", "none", "null"}:
        return False
    if parse_datetime(job.get("PlannedStart")):
        return False
    return True


def diary_blocks(jobs: list[dict[str, Any]], day: dt.date) -> list[tuple[dt.datetime, dt.datetime, str]]:
    blocks: list[tuple[dt.datetime, dt.datetime, str]] = []
    for job in jobs:
        start = parse_datetime(job.get("PlannedStart"))
        end = parse_datetime(job.get("PlannedEnd"))
        if not start or start.date() != day:
            continue
        if not end:
            duration = parse_duration(job.get("Duration"))
            if not duration:
                duration = 60
            end = start + dt.timedelta(minutes=duration)
        if not end or end <= start:
            continue
        status_id = as_int(job.get("StatusId"))
        if status_id in CLOSED_STATUS_IDS and normalise(job.get("Status")) == "cancelled":
            continue
        label = f"{job.get('Ref')} {start.strftime('%H:%M')}-{end.strftime('%H:%M')} ({job.get('Type')})"
        blocks.append((start, end, label))
    blocks.sort(key=lambda item: item[0])
    return blocks


def current_local_date() -> dt.date:
    return dt.date.today()


def earliest_slot_start(day: dt.date, now: dt.datetime | None = None) -> dt.datetime:
    day_start, day_end = working_window(day)
    if now is None:
        now = dt.datetime.now()
    if day > now.date():
        return day_start
    if day < now.date():
        return day_end
    return max(day_start, now.replace(second=0, microsecond=0) + dt.timedelta(minutes=15 - now.minute % 15))


def find_slot(blocks: list[tuple[dt.datetime, dt.datetime, str]], day: dt.date, duration_minutes: int) -> SlotProposal | None:
    _, day_end = working_window(day)
    cursor = earliest_slot_start(day)
    if cursor >= day_end:
        return None
    duration = dt.timedelta(minutes=duration_minutes)

    for start, end, label in blocks:
        if end <= cursor:
            continue
        if start >= day_end:
            break
        if cursor + duration <= min(start, day_end):
            slot_end = cursor + duration
            before = next((block_label for block_start, block_end, block_label in blocks if block_end <= cursor), "None before slot")
            return SlotProposal(
                date=day,
                start=cursor.time(),
                end=slot_end.time(),
                duration_minutes=duration_minutes,
                booking_before=before,
                booking_after=label,
            )
        cursor = max(cursor, end)

    if cursor + duration <= day_end:
        before = blocks[-1][2] if blocks else "None before slot"
        slot_end = cursor + duration
        return SlotProposal(
            date=day,
            start=cursor.time(),
            end=slot_end.time(),
            duration_minutes=duration_minutes,
            booking_before=before,
            booking_after="None after slot",
        )
    return None


def choose_resource(
    client: BigChangeClient,
    site: str,
    required_role: str,
    duration_minutes: int,
    rules: dict[str, Any],
    search_days: int = 14,
) -> tuple[ResourceCandidate | None, SlotProposal | None, list[str]]:
    warnings: list[str] = []
    resources = client.resources()
    candidates: list[ResourceCandidate] = []
    for resource in resources:
        name = str(resource.get("label") or "")
        if not resource_is_active_for_jobwatch(resource):
            continue
        if resource_is_excluded(name, rules):
            continue
        if resource_site(name, rules) != site:
            continue
        role = resource_role(name, rules)
        if not role:
            continue
        if required_role == "HK" and role != "HK":
            continue
        if required_role in {"Tech", "CT"} and role not in {"Tech", "CT"}:
            continue
        candidates.append(ResourceCandidate(resource_id=int(resource["id"]), name=name, role=role, booked_minutes=0, job_count=0))

    if not candidates:
        return None, None, ["No suitable active site-based resource found for required role"]

    start_day = next_working_day(dt.date.today())
    end_day = start_day + dt.timedelta(days=search_days)
    best: tuple[ResourceCandidate, SlotProposal] | None = None

    for candidate in candidates:
        diary = client.resource_diary(candidate.resource_id, start_day, end_day)
        active_jobs = [job for job in diary if as_int(job.get("StatusId")) not in CLOSED_STATUS_IDS or normalise(job.get("Status")) not in {"completed", "cancelled"}]
        candidate.job_count = len(active_jobs)
        candidate.booked_minutes = sum(parse_duration(job.get("Duration")) or 60 for job in active_jobs)
        for offset in range(search_days + 1):
            day = start_day + dt.timedelta(days=offset)
            if day.weekday() >= 5:
                continue
            blocks = diary_blocks(active_jobs, day)
            slot = find_slot(blocks, day, duration_minutes)
            if not slot:
                continue
            if best is None:
                best = (candidate, slot)
                continue
            best_candidate, best_slot = best
            if slot.date < best_slot.date or (slot.date == best_slot.date and slot.start < best_slot.start):
                best = (candidate, slot)
            elif slot.date == best_slot.date and slot.start == best_slot.start and candidate.booked_minutes < best_candidate.booked_minutes:
                best = (candidate, slot)
        warnings.append("Absence status could not be independently verified beyond diary availability")

    if best is None:
        return None, None, list(dict.fromkeys(warnings)) + ["No suitable diary slot found within search window"]
    return best[0], best[1], list(dict.fromkeys(warnings))


def fetch_unallocated_jobs(client: BigChangeClient, lookback_days: int = 180) -> list[dict[str, Any]]:
    today = dt.date.today()
    start = today - dt.timedelta(days=lookback_days)
    end = today + dt.timedelta(days=30)
    rows = client.jobs_list(
        {
            "Start": start.isoformat(),
            "End": end.isoformat(),
            "DateOptionId": 2,
            "Unallocated": 1,
            "StatusId": "1|3",
            "includeExtra": 1,
        }
    )
    return [job for job in rows if is_unallocated(job)]


def build_recommendation(client: BigChangeClient, job: dict[str, Any], rules: dict[str, Any]) -> Recommendation | tuple[str, str]:
    excluded, exclusion_reason = contractor_exclusion(job, rules)
    if excluded:
        return job.get("Ref", ""), exclusion_reason

    site_match = identify_site(job, rules)
    if not site_match:
        return job.get("Ref", ""), "Site could not be identified confidently"

    role_match = determine_role(job)
    if not role_match.role:
        return job.get("Ref", ""), role_match.reason

    duration, duration_reason, duration_confidence = estimate_duration(job, rules)
    resource, slot, warnings = choose_resource(client, site_match.site, role_match.role, duration, rules)
    if not resource or not slot:
        return job.get("Ref", ""), "; ".join(warnings)

    due = parse_datetime(job.get("DueDate"))
    if due and due.date() < slot.date:
        warnings.append(
            f"Proposed date {slot.date.isoformat()} is after target completion date {due.date().isoformat()}"
        )

    confidence_parts = [site_match.confidence, role_match.confidence, duration_confidence]
    if "Medium" in confidence_parts:
        overall = "Medium"
    elif "Low" in confidence_parts:
        overall = "Low"
    else:
        overall = "High"

    return Recommendation(
        job_ref=str(job.get("Ref") or ""),
        job_id=int(job.get("JobId") or 0),
        site=site_match.site,
        site_identification=site_match.method,
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
            f"Selected {resource.name} ({resource.role}) as an active JobWatch resource "
            f"(Resource4Schedule=1) with earliest suitable {site_match.site} diary capacity "
            f"({resource.job_count} diary jobs, {resource.booked_minutes} booked minutes in search window)"
        ),
        contractor_check="Passed",
        overlap_check="Passed",
        booking_before=slot.booking_before,
        booking_after=slot.booking_after,
        priority=str(job.get("CurrentFlag") or job.get("Status") or "Routine"),
        target_date=str(job.get("DueDate") or "Not specified"),
        confidence=overall,
        assumptions=warnings,
    )


def render_candidate_report(recommendation: Recommendation) -> str:
    assumptions = "\n".join(f"- {item}" for item in recommendation.assumptions) or "- None"
    return f"""Candidate allocation test

Job reference: {recommendation.job_ref}
Site: {recommendation.site}
Job description: {recommendation.description}
Required resource type: {recommendation.required_role}
Proposed resource: {recommendation.proposed_resource}
Proposed date: {recommendation.proposed_date}
Proposed start time: {recommendation.proposed_start}
Proposed end time: {recommendation.proposed_end}
Estimated duration: {recommendation.duration_minutes} minutes
Reason for duration: {recommendation.duration_reason}
Reason for resource selection: {recommendation.resource_reason}
Contractor exclusion check: {recommendation.contractor_check}
Diary overlap check: {recommendation.overlap_check}
Existing booking before: {recommendation.booking_before}
Existing booking after: {recommendation.booking_after}
Job priority: {recommendation.priority}
Target date: {recommendation.target_date}
Confidence: {recommendation.confidence}
Assumptions or warnings:
{assumptions}

No changes have been made to BigChange. Administrator approval is required before this allocation is implemented.
"""


def main() -> int:
    parser = argparse.ArgumentParser(description="BTR job allocation recommendation (read-only)")
    parser.add_argument("--job-ref", help="Specific job reference to evaluate")
    parser.add_argument("--output", default="reports/btr-candidate-allocation-test.md")
    parser.add_argument("--list-candidates", action="store_true", help="List eligible BTR unallocated jobs")
    args = parser.parse_args()

    try:
        rules = load_rules()
        client = BigChangeClient()
        jobs = fetch_unallocated_jobs(client)
        eligible: list[tuple[Recommendation, dict[str, Any]]] = []
        exceptions: list[tuple[str, str]] = []

        for job in jobs:
            site_match = identify_site(job, rules)
            if not site_match:
                continue
            result = build_recommendation(client, job, rules)
            if isinstance(result, tuple):
                exceptions.append(result)
                continue
            eligible.append((result, job))

        if args.list_candidates:
            print(json.dumps({"eligible_count": len(eligible), "exception_count": len(exceptions)}, indent=2))
            for recommendation, _job in eligible[:20]:
                print(f"{recommendation.job_ref}\t{recommendation.site}\t{recommendation.required_role}\t{recommendation.confidence}")
            return 0

        selected: Recommendation | None = None
        if args.job_ref:
            selected = next((rec for rec, _job in eligible if rec.job_ref == args.job_ref), None)
            if not selected:
                print(f"No eligible recommendation found for job ref {args.job_ref}", file=sys.stderr)
                return 1
        elif eligible:
            eligible.sort(key=lambda item: (0 if item[0].required_role == "Tech" else 1, item[0].confidence != "High", item[0].job_ref))
            selected = eligible[0][0]
        else:
            print("No eligible BTR jobs found for recommendation", file=sys.stderr)
            return 1

        report = render_candidate_report(selected)
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(report, encoding="utf-8")
        print(report)
        print(json.dumps({"output": str(output_path), "job_ref": selected.job_ref, "mode": "recommendation_only"}, indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc), "mode": "recommendation_only"}, indent=2), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
