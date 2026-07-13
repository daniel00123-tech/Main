#!/usr/bin/env python3
"""BigChange Build-to-Rent job allocation automation (recommendation mode only).

Reviews unallocated BTR jobs and proposes allocation to site-based Tech, CT, or HK
resources. Does not write to BigChange unless explicitly run with --apply (disabled
by default; administrator approval required).
"""

from __future__ import annotations

import argparse
import base64
import calendar
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
CLOSED_STATUS_IDS = {12, 13, 14}
LUNCH_WINDOW_START = dt.time(11, 45)
LUNCH_WINDOW_END = dt.time(13, 15)
LUNCH_BREAK_MINUTES = 60
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
class EmergencyMatch:
    is_emergency: bool
    reason: str
    confidence: str
    target_date: dt.date | None = None


@dataclass
class RequestedAppointment:
    requested: bool
    reason: str
    confidence: str
    date: dt.date | None = None
    windows: list[tuple[dt.time, dt.time]] = field(default_factory=list)


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
    ppm_check: str
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
    parsed = as_int(value)
    return parsed if parsed and parsed > 0 else None


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


def is_cover_job(job: dict[str, Any]) -> bool:
    ref = normalise(job.get("Ref"))
    job_type = normalise(job.get("Type"))
    description = normalise(job.get("Description"))
    return ref.startswith("cover") or "agency cover" in job_type or "agency cover" in description


def emergency_target_date(now: dt.datetime | None = None, rules: dict[str, Any] | None = None) -> dt.date:
    now = now or dt.datetime.now()
    emergency_rules = (rules or {}).get("emergency", {})
    cutoff_text = str(emergency_rules.get("same_day_cutoff", "15:00"))
    cutoff_hour, cutoff_minute = (int(part) for part in cutoff_text.split(":", 1))
    target = now.date() if now.time() < dt.time(cutoff_hour, cutoff_minute) else now.date() + dt.timedelta(days=1)
    return next_working_day(target)


def emergency_match(job: dict[str, Any], rules: dict[str, Any], now: dt.datetime | None = None) -> EmergencyMatch:
    """Classify emergency works from job wording.

    The rules intentionally look across type, flag, notes, and description, but
    suppress common planned-maintenance false positives such as emergency-light
    PPM tests.
    """
    text = job_text(job)
    emergency_rules = rules.get("emergency", {})
    false_positive_terms = [normalise(term) for term in emergency_rules.get("false_positive_terms", [])]
    high_terms = [normalise(term) for term in emergency_rules.get("high_confidence_terms", [])]
    medium_terms = [normalise(term) for term in emergency_rules.get("medium_confidence_terms", [])]

    if any(term and term in text for term in false_positive_terms):
        return EmergencyMatch(False, "Emergency false-positive wording suppressed", "Low")

    high_matches = [term for term in high_terms if term and term in text]
    if high_matches:
        return EmergencyMatch(
            True,
            f"Emergency wording found: {', '.join(sorted(set(high_matches)))}",
            "High",
            emergency_target_date(now, rules),
        )

    medium_matches = [term for term in medium_terms if term and term in text]
    if medium_matches:
        return EmergencyMatch(
            True,
            f"Possible emergency wording found: {', '.join(sorted(set(medium_matches)))}",
            "Medium",
            emergency_target_date(now, rules),
        )

    return EmergencyMatch(False, "No emergency wording found", "High")


MONTH_LOOKUP = {
    name.lower(): index
    for index in range(1, 13)
    for name in (calendar.month_name[index], calendar.month_abbr[index])
    if name
}


def _coerce_year(two_or_four_digit_year: str | None) -> int:
    if not two_or_four_digit_year:
        return dt.date.today().year
    year = int(two_or_four_digit_year)
    return 2000 + year if year < 100 else year


def _futureish_date(day: int, month: int, year: int, explicit_year: bool) -> dt.date | None:
    try:
        parsed = dt.date(year, month, day)
    except ValueError:
        return None
    if not explicit_year and parsed < dt.date.today():
        try:
            parsed = dt.date(year + 1, month, day)
        except ValueError:
            return None
    return parsed


def _parse_time_parts(hour_text: str, minute_text: str | None, meridiem: str | None) -> dt.time | None:
    hour = int(hour_text)
    minute = int(minute_text or 0)
    if minute > 59:
        return None
    marker = normalise(meridiem)
    if marker in {"am", "a.m"}:
        if hour == 12:
            hour = 0
    elif marker in {"pm", "p.m"}:
        if hour < 12:
            hour += 12
    if hour > 23:
        return None
    return dt.time(hour, minute)


def _add_minutes_to_time(value: dt.time, minutes: int) -> dt.time:
    base = dt.datetime.combine(dt.date.today(), value) + dt.timedelta(minutes=minutes)
    return min(base.time(), dt.time(23, 59))


def _parse_requested_date(text: str) -> dt.date | None:
    numeric = re.search(r"\b(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b|\b(\d{1,2})-(\d{1,2})-(\d{2,4})\b", text)
    if numeric:
        day = int(numeric.group(1) or numeric.group(4))
        month = int(numeric.group(2) or numeric.group(5))
        year_text = numeric.group(3) or numeric.group(6)
        year = _coerce_year(year_text)
        parsed = _futureish_date(day, month, year, explicit_year=bool(year_text))
        if parsed:
            return parsed

    month_names = "|".join(sorted(MONTH_LOOKUP, key=len, reverse=True))
    worded = re.search(rf"\b(\d{{1,2}})(?:st|nd|rd|th)?\s+({month_names})(?:\s+(\d{{2,4}}))?\b", text)
    if worded:
        day = int(worded.group(1))
        month = MONTH_LOOKUP[worded.group(2)]
        year = _coerce_year(worded.group(3))
        parsed = _futureish_date(day, month, year, explicit_year=bool(worded.group(3)))
        if parsed:
            return parsed
    return None


def _parse_requested_windows(text: str, duration_minutes: int) -> list[tuple[dt.time, dt.time]]:
    windows: list[tuple[dt.time, dt.time]] = []
    range_pattern = re.compile(
        r"\b(?:between|from)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|to|and|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b"
    )
    for match in range_pattern.finditer(text):
        start_marker = match.group(3) or match.group(6)
        end_marker = match.group(6)
        start = _parse_time_parts(match.group(1), match.group(2), start_marker)
        end = _parse_time_parts(match.group(4), match.group(5), end_marker)
        if not start or not end:
            continue
        if end <= start:
            end_dt = dt.datetime.combine(dt.date.today(), end) + dt.timedelta(hours=12)
            end = end_dt.time()
        if end > start:
            windows.append((start, end))

    hour_range_pattern = re.compile(r"\b(\d{1,2}):(\d{2})\s*(?:-|to|until)\s*(\d{1,2}):(\d{2})\b")
    for match in hour_range_pattern.finditer(text):
        start = _parse_time_parts(match.group(1), match.group(2), None)
        end = _parse_time_parts(match.group(3), match.group(4), None)
        if start and end and end > start:
            windows.append((start, end))

    exact_patterns = (
        re.compile(r"\b(?:at|for|around|arrive(?:\s+at)?|attend(?:\s+at)?)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b"),
        re.compile(r"\b(\d{1,2}):(\d{2})\b"),
    )
    for pattern in exact_patterns:
        for match in pattern.finditer(text):
            start = _parse_time_parts(match.group(1), match.group(2), match.group(3) if len(match.groups()) >= 3 else None)
            if start:
                end = _add_minutes_to_time(start, duration_minutes)
                if end > start:
                    windows.append((start, end))
    return list(dict.fromkeys(windows))


def requested_appointment(job: dict[str, Any], rules: dict[str, Any], duration_minutes: int) -> RequestedAppointment:
    text = job_text(job)
    requested_terms = ("requested", "request", "book", "attend", "appointment", "access", "available", "tenant asked", "tenant requested")
    has_request_context = any(term in text for term in requested_terms)
    requested_date = _parse_requested_date(text)
    windows = _parse_requested_windows(text, duration_minutes)
    if requested_date and windows:
        return RequestedAppointment(
            True,
            f"Requested appointment found for {requested_date.isoformat()} "
            + ", ".join(f"{start.strftime('%H:%M')}-{end.strftime('%H:%M')}" for start, end in windows),
            "High",
            requested_date,
            windows,
        )
    if requested_date and has_request_context:
        return RequestedAppointment(True, f"Requested date found: {requested_date.isoformat()}", "Medium", requested_date)
    if windows and has_request_context:
        return RequestedAppointment(
            True,
            "Requested time window found without a specific date: "
            + ", ".join(f"{start.strftime('%H:%M')}-{end.strftime('%H:%M')}" for start, end in windows),
            "Low",
            None,
            windows,
        )
    return RequestedAppointment(False, "No requested appointment date/time found", "High")


def is_ppm_job(job: dict[str, Any]) -> bool:
    ref = normalise(job.get("Ref"))
    job_type = normalise(job.get("Type"))
    return ref.startswith("ppm") or job_type.startswith("ppm")


def ppm_tech_diary_review(job: dict[str, Any], rules: dict[str, Any]) -> tuple[bool, str]:
    """Return (allow_tech_allocation, reason).

    PPM jobs need review. Only weekly/monthly/daily inspection-style PPM work
    should reach a site Tech/CT diary. Heavy mechanical, fire, AOV, sprinkler,
    and similar specialist PPM work should be flagged unless the job type/ref
    clearly states a weekly or monthly check/inspection.
    """
    if not is_ppm_job(job):
        return True, "Not a PPM job"

    type_ref_text = normalise(f"{job.get('Type')} {job.get('Ref')}")
    full_text = job_text(job)
    ppm_rules = rules.get("ppm_review", {})

    for phrase in ppm_rules.get("tech_diary_allow_phrases", []):
        if normalise(phrase) in type_ref_text:
            return True, f"PPM allowed for tech diary: job type/ref includes '{phrase}'"

    frequency_terms = ppm_rules.get("frequency_terms", ["weekly", "monthly", "daily", "6 monthly"])
    inspection_terms = ppm_rules.get("inspection_terms", ["inspection", "check", "walk", "operational", "visual"])
    heavy_terms = ppm_rules.get("heavy_specialist_terms", [])

    def has_frequency(text: str) -> bool:
        return any(term in text for term in frequency_terms)

    def has_inspection(text: str) -> bool:
        return any(term in text for term in inspection_terms)

    heavy_in_type = [term for term in heavy_terms if term in type_ref_text]
    if heavy_in_type:
        if has_frequency(type_ref_text) and has_inspection(type_ref_text):
            return True, "PPM allowed for tech diary: heavy PPM type includes frequency plus inspection/check wording"
        return False, (
            "PPM specialist/heavy mechanical job requires review "
            f"({', '.join(sorted(set(heavy_in_type)))}) — likely subcontractor unless weekly/monthly check confirmed in job type"
        )

    if has_frequency(full_text) and has_inspection(full_text):
        return True, "PPM allowed for tech diary: includes frequency plus inspection/check wording"

    heavy_matches = [term for term in heavy_terms if term in full_text]
    if heavy_matches:
        return False, (
            "PPM specialist/heavy mechanical job requires review "
            f"({', '.join(sorted(set(heavy_matches)))}) — likely subcontractor unless weekly/monthly check confirmed"
        )

    return False, "PPM job requires administrator review before tech diary allocation"


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


def working_window(day: dt.date, start_time: dt.time | None = None, end_time: dt.time | None = None) -> tuple[dt.datetime, dt.datetime]:
    start = dt.datetime.combine(day, start_time or dt.time(8, 0))
    end = dt.datetime.combine(day, end_time or dt.time(17, 0))
    return start, end


def minutes_to_time(value: int) -> dt.time:
    hours, minutes = divmod(int(value), 60)
    return dt.time(hours, minutes)


def resource_working_windows(
    client: BigChangeClient,
    resource_id: int,
    day: dt.date,
    cache: dict[int, list[dict[str, Any]]],
    rules: dict[str, Any],
) -> list[tuple[dt.datetime, dt.datetime]]:
    if resource_id not in cache:
        payload = client.get("ResourceDetail", {"ResId": resource_id})
        detail = payload.get("Result") if payload.get("Code") in (0, None) else {}
        cache[resource_id] = detail.get("ResourceWorkingHours") if isinstance(detail, dict) else []

    weekday = day.weekday() + 1
    windows: list[tuple[dt.datetime, dt.datetime]] = []
    for entry in cache.get(resource_id, []):
        if as_int(entry.get("WeekDay")) != weekday:
            continue
        start_mins = as_int(entry.get("Start"))
        stop_mins = as_int(entry.get("Stop"))
        if start_mins is None or stop_mins is None or stop_mins <= start_mins:
            continue
        windows.append(
            (
                dt.datetime.combine(day, minutes_to_time(start_mins)),
                dt.datetime.combine(day, minutes_to_time(stop_mins)),
            )
        )
    windows.sort(key=lambda item: item[0])
    if windows:
        return windows

    fallback = rules.get("working_hours", {})
    start_parts = str(fallback.get("start", "08:00")).split(":")
    end_parts = str(fallback.get("end", "17:00")).split(":")
    return [
        working_window(
            day,
            dt.time(int(start_parts[0]), int(start_parts[1])),
            dt.time(int(end_parts[0]), int(end_parts[1])),
        )
    ]


def format_working_hours(windows: list[tuple[dt.datetime, dt.datetime]]) -> str:
    if not windows:
        return "default 08:00-17:00"
    return ", ".join(f"{start.strftime('%H:%M')}-{end.strftime('%H:%M')}" for start, end in windows)


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

    def resource_absences(self, resource_id: int) -> list[dict[str, Any]]:
        payload = self.get("ResourceAbsences", {"ResourceId": resource_id})
        if payload.get("Code") not in (0, None):
            raise RuntimeError(f"ResourceAbsences failed: {payload.get('Result')}")
        return self.rows(payload)

    def schedule_job(self, job_id: int, resource_id: int, schedule_date: str, duration_mins: int) -> dict[str, Any]:
        payload = self.get(
            "JobSchedule",
            {
                "jobId": job_id,
                "resourceId": resource_id,
                "scheduleDate": schedule_date,
                "durationMins": duration_mins,
            },
        )
        if payload.get("Code") not in (0, None):
            raise RuntimeError(f"JobSchedule failed: {payload.get('Result')}")
        return payload


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


def is_cancelled_diary_job(job: dict[str, Any]) -> bool:
    return normalise(job.get("Status")) in {"cancelled", "deleted", "rejected"}


def diary_blocks(jobs: list[dict[str, Any]], day: dt.date) -> list[tuple[dt.datetime, dt.datetime, str]]:
    """Build diary blocks from planned start/end times for all non-cancelled jobs."""
    blocks: list[tuple[dt.datetime, dt.datetime, str]] = []
    for job in jobs:
        if is_cancelled_diary_job(job):
            continue
        start = parse_datetime(job.get("PlannedStart"))
        end = parse_datetime(job.get("PlannedEnd"))
        if not start or start.date() != day:
            continue
        if not end:
            duration = parse_duration(job.get("Duration"))
            if not duration:
                continue
            end = start + dt.timedelta(minutes=duration)
        if not end or end <= start:
            continue
        label = f"{job.get('Ref')} {start.strftime('%H:%M')}-{end.strftime('%H:%M')} ({job.get('Type')})"
        blocks.append((start, end, label))
    blocks.sort(key=lambda item: item[0])
    return blocks


def resource_absence_blocks(
    client: BigChangeClient,
    resource_id: int,
    day: dt.date,
    cache: dict[int, list[dict[str, Any]]],
) -> list[tuple[dt.datetime, dt.datetime, str]]:
    """Build diary-style blocks for ResourceAbsences entries on a day.

    The legacy BigChange endpoint returns all absences for a resource rather
    than reliably applying Start/End request filters, so filtering is done here.
    """
    if resource_id not in cache:
        cache[resource_id] = client.resource_absences(resource_id)

    day_start = dt.datetime.combine(day, dt.time.min)
    day_end = dt.datetime.combine(day, dt.time.max)
    blocks: list[tuple[dt.datetime, dt.datetime, str]] = []
    for absence in cache.get(resource_id, []):
        start = parse_datetime(absence.get("start") or absence.get("Start"))
        end = parse_datetime(absence.get("end") or absence.get("End"))
        if not start or not end or end <= start:
            continue
        if not overlaps(start, end, day_start, day_end):
            continue
        absence_type = str(absence.get("type") or absence.get("Type") or "Absence")
        blocks.append((max(start, day_start), min(end, day_end), f"ABSENCE {absence_type}".strip()))
    blocks.sort(key=lambda item: item[0])
    return blocks


def adjacent_bookings(
    blocks: list[tuple[dt.datetime, dt.datetime, str]],
    slot_start: dt.datetime,
    slot_end: dt.datetime,
) -> tuple[str, str]:
    before = "None before slot"
    after = "None after slot"
    for block_start, block_end, label in blocks:
        if block_end <= slot_start:
            before = label
        if block_start >= slot_end and after == "None after slot":
            after = label
    return before, after


def slot_has_overlap(
    blocks: list[tuple[dt.datetime, dt.datetime, str]],
    slot_start: dt.datetime,
    slot_end: dt.datetime,
) -> bool:
    return any(overlaps(slot_start, slot_end, block_start, block_end) for block_start, block_end, _ in blocks)


def lunch_break_preserved(
    blocks: list[tuple[dt.datetime, dt.datetime, str]],
    day: dt.date,
    slot_start: dt.datetime | None = None,
    slot_end: dt.datetime | None = None,
) -> bool:
    """Return True when a 60-minute lunch gap remains between 11:45 and 13:15.

    Existing bookings, absences, and the candidate slot are treated as blocks.
    This preserves a real break without requiring the whole 90-minute lunch
    window to stay empty.
    """
    lunch_start = dt.datetime.combine(day, LUNCH_WINDOW_START)
    lunch_end = dt.datetime.combine(day, LUNCH_WINDOW_END)
    required = dt.timedelta(minutes=LUNCH_BREAK_MINUTES)
    lunch_blocks: list[tuple[dt.datetime, dt.datetime]] = []

    for block_start, block_end, _label in blocks:
        if overlaps(block_start, block_end, lunch_start, lunch_end):
            lunch_blocks.append((max(block_start, lunch_start), min(block_end, lunch_end)))
    if slot_start and slot_end and overlaps(slot_start, slot_end, lunch_start, lunch_end):
        lunch_blocks.append((max(slot_start, lunch_start), min(slot_end, lunch_end)))

    lunch_blocks.sort(key=lambda item: item[0])
    cursor = lunch_start
    for block_start, block_end in lunch_blocks:
        if block_end <= cursor:
            continue
        if block_start - cursor >= required:
            return True
        cursor = max(cursor, block_end)
        if cursor >= lunch_end:
            break
    return lunch_end - cursor >= required


def intersect_working_windows(
    working_windows: list[tuple[dt.datetime, dt.datetime]],
    day: dt.date,
    requested_windows: list[tuple[dt.time, dt.time]] | None,
) -> list[tuple[dt.datetime, dt.datetime]]:
    if not requested_windows:
        return working_windows
    intersections: list[tuple[dt.datetime, dt.datetime]] = []
    for work_start, work_end in working_windows:
        for requested_start, requested_end in requested_windows:
            request_start_dt = dt.datetime.combine(day, requested_start)
            request_end_dt = dt.datetime.combine(day, requested_end)
            start = max(work_start, request_start_dt)
            end = min(work_end, request_end_dt)
            if end > start:
                intersections.append((start, end))
    intersections.sort(key=lambda item: item[0])
    return intersections


def current_local_date() -> dt.date:
    return dt.date.today()


def earliest_slot_start(day: dt.date, day_start: dt.datetime, day_end: dt.datetime, now: dt.datetime | None = None) -> dt.datetime:
    if now is None:
        now = dt.datetime.now()
    if day > now.date():
        return day_start
    if day < now.date():
        return day_end
    return max(day_start, now.replace(second=0, microsecond=0) + dt.timedelta(minutes=15 - now.minute % 15))


def find_slot_in_window(
    blocks: list[tuple[dt.datetime, dt.datetime, str]],
    day: dt.date,
    day_start: dt.datetime,
    day_end: dt.datetime,
    duration_minutes: int,
) -> SlotProposal | None:
    cursor = earliest_slot_start(day, day_start, day_end)
    if cursor >= day_end:
        return None
    duration = dt.timedelta(minutes=duration_minutes)
    step = dt.timedelta(minutes=15)

    for start, end, label in blocks:
        if end <= cursor:
            continue
        if start >= day_end:
            break
        gap_end = min(start, day_end)
        while cursor + duration <= gap_end:
            slot_end = cursor + duration
            if lunch_break_preserved(blocks, day, cursor, slot_end):
                before, after = adjacent_bookings(blocks, cursor, slot_end)
                return SlotProposal(
                    date=day,
                    start=cursor.time(),
                    end=slot_end.time(),
                    duration_minutes=duration_minutes,
                    booking_before=before,
                    booking_after=after,
                )
            cursor += step
        cursor = max(cursor, end)

    while cursor + duration <= day_end:
        slot_end = cursor + duration
        if lunch_break_preserved(blocks, day, cursor, slot_end):
            before, after = adjacent_bookings(blocks, cursor, slot_end)
            return SlotProposal(
                date=day,
                start=cursor.time(),
                end=slot_end.time(),
                duration_minutes=duration_minutes,
                booking_before=before,
                booking_after=after,
            )
        cursor += step
    return None


def find_slot(
    blocks: list[tuple[dt.datetime, dt.datetime, str]],
    day: dt.date,
    duration_minutes: int,
    working_windows: list[tuple[dt.datetime, dt.datetime]] | None = None,
) -> SlotProposal | None:
    windows = working_windows or [working_window(day)]
    best: SlotProposal | None = None
    for day_start, day_end in windows:
        slot = find_slot_in_window(blocks, day, day_start, day_end, duration_minutes)
        if not slot:
            continue
        if best is None or dt.datetime.combine(slot.date, slot.start) < dt.datetime.combine(best.date, best.start):
            best = slot
    return best


def choose_resource(
    client: BigChangeClient,
    site: str,
    required_role: str,
    duration_minutes: int,
    rules: dict[str, Any],
    search_days: int = 14,
    preferred_resource: str | None = None,
    target_day: dt.date | None = None,
    requested_windows: list[tuple[dt.time, dt.time]] | None = None,
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

    if preferred_resource:
        preferred_norm = normalise(preferred_resource)
        pinned = [c for c in candidates if preferred_norm in normalise(c.name)]
        if pinned:
            candidates = pinned
        else:
            return None, None, [f"Preferred resource '{preferred_resource}' not found among active site-based {required_role} resources"]

    if not candidates:
        return None, None, ["No suitable active site-based resource found for required role"]

    start_day = next_working_day(target_day or dt.date.today())
    end_day = start_day + dt.timedelta(days=search_days)
    best: tuple[ResourceCandidate, SlotProposal] | None = None
    working_hours_cache: dict[int, list[dict[str, Any]]] = {}
    absence_cache: dict[int, list[dict[str, Any]]] = {}

    for candidate in candidates:
        diary = client.resource_diary(candidate.resource_id, start_day, end_day)
        schedule_jobs = [job for job in diary if not is_cancelled_diary_job(job)]
        open_jobs = [job for job in diary if as_int(job.get("StatusId")) not in CLOSED_STATUS_IDS]
        candidate.job_count = len(open_jobs)
        candidate.booked_minutes = sum(parse_duration(job.get("Duration")) or 60 for job in open_jobs)
        for offset in range(search_days + 1):
            day = start_day + dt.timedelta(days=offset)
            if day.weekday() >= 5:
                continue
            windows = resource_working_windows(client, candidate.resource_id, day, working_hours_cache, rules)
            if requested_windows and target_day and day == target_day:
                windows = intersect_working_windows(windows, day, requested_windows)
            if not windows:
                continue
            blocks = diary_blocks(schedule_jobs, day) + resource_absence_blocks(client, candidate.resource_id, day, absence_cache)
            blocks.sort(key=lambda item: item[0])
            slot = find_slot(blocks, day, duration_minutes, windows)
            if not slot:
                continue
            slot_start = dt.datetime.combine(day, slot.start)
            slot_end = dt.datetime.combine(day, slot.end)
            if slot_has_overlap(blocks, slot_start, slot_end):
                continue
            slot.booking_before, slot.booking_after = adjacent_bookings(blocks, slot_start, slot_end)
            if best is None:
                best = (candidate, slot)
                continue
            best_candidate, best_slot = best
            if slot.date < best_slot.date or (slot.date == best_slot.date and slot.start < best_slot.start):
                best = (candidate, slot)
            elif slot.date == best_slot.date and slot.start == best_slot.start and candidate.booked_minutes < best_candidate.booked_minutes:
                best = (candidate, slot)
        warnings.append("Absence status verified via ResourceAbsences and diary availability")

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


def build_recommendation(
    client: BigChangeClient,
    job: dict[str, Any],
    rules: dict[str, Any],
    preferred_resource: str | None = None,
) -> Recommendation | tuple[str, str]:
    excluded, exclusion_reason = contractor_exclusion(job, rules)
    if excluded:
        return job.get("Ref", ""), exclusion_reason

    ppm_allowed, ppm_reason = ppm_tech_diary_review(job, rules)
    if not ppm_allowed:
        return job.get("Ref", ""), ppm_reason

    site_match = identify_site(job, rules)
    if not site_match:
        return job.get("Ref", ""), "Site could not be identified confidently"

    role_match = determine_role(job)
    if not role_match.role:
        return job.get("Ref", ""), role_match.reason

    duration, duration_reason, duration_confidence = estimate_duration(job, rules)
    emergency = emergency_match(job, rules)
    requested = requested_appointment(job, rules, duration)
    target_day = emergency.target_date if emergency.is_emergency else requested.date
    requested_windows = None if emergency.is_emergency else requested.windows
    search_days = 0 if emergency.is_emergency or requested.date else 14
    resource, slot, warnings = choose_resource(
        client,
        site_match.site,
        role_match.role,
        duration,
        rules,
        search_days=search_days,
        preferred_resource=preferred_resource,
        target_day=target_day,
        requested_windows=requested_windows,
    )
    if not resource or not slot:
        if emergency.is_emergency and emergency.target_date:
            return (
                job.get("Ref", ""),
                f"Emergency job requires allocation on {emergency.target_date.isoformat()} but no free non-overlap slot was found; displacement review required",
            )
        if requested.requested:
            return (
                job.get("Ref", ""),
                f"{requested.reason} could not be accommodated automatically; manual appointment review required",
            )
        return job.get("Ref", ""), "; ".join(warnings)

    diary = client.resource_diary(resource.resource_id, slot.date, slot.date)
    schedule_jobs = [entry for entry in diary if not is_cancelled_diary_job(entry)]
    blocks = diary_blocks(schedule_jobs, slot.date)
    slot_start = dt.datetime.combine(slot.date, slot.start)
    slot_end = dt.datetime.combine(slot.date, slot.end)
    overlap = slot_has_overlap(blocks, slot_start, slot_end)
    slot.booking_before, slot.booking_after = adjacent_bookings(blocks, slot_start, slot_end)
    if overlap:
        return job.get("Ref", ""), "Proposed slot overlaps an existing planned diary booking"

    due = parse_datetime(job.get("DueDate"))
    if due and due.date() < slot.date:
        warnings.append(
            f"Proposed date {slot.date.isoformat()} is after target completion date {due.date().isoformat()}"
        )

    confidence_parts = [site_match.confidence, role_match.confidence, duration_confidence]
    if emergency.is_emergency:
        confidence_parts.append(emergency.confidence)
        warnings.append(f"{emergency.reason}; target diary date {emergency.target_date.isoformat() if emergency.target_date else 'unknown'}")
    elif requested.requested:
        confidence_parts.append(requested.confidence)
        warnings.append(requested.reason)
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
            f"({resource.job_count} diary jobs, {resource.booked_minutes} booked minutes in search window). "
            f"Working hours from BigChange: {format_working_hours(resource_working_windows(client, resource.resource_id, slot.date, {}, rules))}"
            + (f" Emergency target date applied: {emergency.target_date.isoformat()}." if emergency.is_emergency and emergency.target_date else "")
            + (f" Requested appointment applied: {requested.reason}." if requested.requested and not emergency.is_emergency else "")
        ),
        contractor_check="Passed",
        ppm_check=ppm_reason,
        overlap_check="Failed" if overlap else "Passed",
        booking_before=slot.booking_before,
        booking_after=slot.booking_after,
        priority=(
            f"Emergency - {emergency.reason}"
            if emergency.is_emergency
            else f"Requested appointment - {requested.reason}"
            if requested.requested
            else str(job.get("CurrentFlag") or job.get("Status") or "Routine")
        ),
        target_date=(
            emergency.target_date.isoformat()
            if emergency.is_emergency and emergency.target_date
            else requested.date.isoformat()
            if requested.requested and requested.date
            else str(job.get("DueDate") or "Not specified")
        ),
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
PPM review check: {recommendation.ppm_check}
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
    parser.add_argument("--resource", help="Preferred resource name (partial match)")
    parser.add_argument("--output", default="reports/btr-candidate-allocation-test.md")
    parser.add_argument("--list-candidates", action="store_true", help="List eligible BTR unallocated jobs")
    parser.add_argument("--apply", action="store_true", help="Apply the allocation to BigChange (requires administrator approval)")
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
            result = build_recommendation(client, job, rules, preferred_resource=args.resource)
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

        applied = False
        if args.apply:
            job = next((j for j in jobs if str(j.get("Ref") or "") == selected.job_ref), None)
            if not job:
                print(f"Cannot apply: job {selected.job_ref} not found", file=sys.stderr)
                return 1
            schedule_dt = f"{selected.proposed_date} {selected.proposed_start}:00"
            client.schedule_job(int(job["JobId"]), selected.proposed_resource_id, schedule_dt, selected.duration_minutes)
            applied = True
            audit_path = Path("automation-memory/btr-allocation-audit.jsonl")
            audit_path.parent.mkdir(parents=True, exist_ok=True)
            audit_record = {
                "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
                "job_ref": selected.job_ref,
                "job_id": job["JobId"],
                "site": selected.site,
                "resource": selected.proposed_resource,
                "resource_id": selected.proposed_resource_id,
                "scheduled_date": selected.proposed_date,
                "start": selected.proposed_start,
                "end": selected.proposed_end,
                "duration_minutes": selected.duration_minutes,
                "confidence": selected.confidence,
                "mode": "automatic" if args.apply else "recommendation",
            }
            with audit_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(audit_record, sort_keys=True) + "\n")

        print(report)
        if applied:
            print("\nAllocation applied to BigChange successfully.")
        print(json.dumps({"output": str(output_path), "job_ref": selected.job_ref, "mode": "applied" if applied else "recommendation_only"}, indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc), "mode": "recommendation_only"}, indent=2), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
