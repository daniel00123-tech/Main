"""Shared helpers for the Aquilo commission pack."""

from __future__ import annotations

import datetime as dt
import decimal
import re
from typing import Any
from zoneinfo import ZoneInfo

from .settings import LONDON

D = decimal.Decimal
ZERO = D("0")
TWOP = D("0.01")
EMPTY = {"", "none", "null", "0", "false", "no", "n", "0001-01-01", "0001-01-01 00:00:00"}


def money(value: D) -> D:
    return value.quantize(TWOP, rounding=decimal.ROUND_HALF_UP)


def as_decimal(value: Any) -> D:
    if value in (None, ""):
        return ZERO
    if isinstance(value, D):
        return value
    try:
        return D(str(value).replace(",", "").strip())
    except (decimal.InvalidOperation, ValueError):
        return ZERO


def as_int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def first_present(row: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        if key in row and row[key] not in (None, ""):
            return row[key]
    lower = {str(k).lower(): v for k, v in row.items()}
    for key in keys:
        value = lower.get(key.lower())
        if value not in (None, ""):
            return value
    return None


def compact_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def clean_name(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def nested_rows(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [row for row in value if isinstance(row, dict)]
    if isinstance(value, dict):
        rows: list[dict[str, Any]] = []
        for nested in value.values():
            if isinstance(nested, list):
                rows.extend(row for row in nested if isinstance(row, dict))
        if rows:
            return rows
        return [value]
    return []


def is_populated(value: Any) -> bool:
    text = clean_name(value)
    if not text:
        return False
    return text.lower() not in EMPTY


def parse_datetime(value: Any, tz: ZoneInfo = LONDON) -> dt.datetime | None:
    if value in (None, "", "0001-01-01 00:00:00", "0001-01-01"):
        return None
    text = str(value).strip()
    if not text:
        return None
    formats = (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d",
        "%d/%m/%Y %H:%M:%S",
        "%d/%m/%Y %H:%M",
        "%d/%m/%Y",
    )
    parsed: dt.datetime | None = None
    for fmt in formats:
        try:
            sample = text[:19] if (" " in text or "T" in text) and "%H" in fmt else text
            parsed = dt.datetime.strptime(sample, fmt)
            break
        except ValueError:
            continue
    if parsed is None:
        try:
            parsed = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=tz)
    return parsed.astimezone(tz)


def parse_date(value: Any, tz: ZoneInfo = LONDON) -> dt.date | None:
    parsed = parse_datetime(value, tz)
    return parsed.date() if parsed else None


def parse_hours(value: Any) -> D:
    """Planned duration as hours. Accepts hours, minutes, or HH:MM."""
    if value in (None, ""):
        return ZERO
    if isinstance(value, (int, float, D)):
        raw = D(str(value))
        # JobWatch sometimes stores minutes as a large integer.
        if raw > D("24") and raw == raw.to_integral_value():
            return raw / D("60")
        return raw
    text = str(value).strip()
    if not text:
        return ZERO
    if re.fullmatch(r"\d{1,2}:\d{2}(:\d{2})?", text):
        parts = [D(p) for p in text.split(":")]
        hours = parts[0]
        minutes = parts[1] if len(parts) > 1 else ZERO
        seconds = parts[2] if len(parts) > 2 else ZERO
        return hours + (minutes / D("60")) + (seconds / D("3600"))
    return as_decimal(text)


def gbp(value: D) -> str:
    sign = "-" if value < 0 else ""
    return f"{sign}£{abs(value):,.2f}"


def format_margin(margin: D | None, places: str = "0.1") -> str:
    if margin is None:
        return "n/a"
    display = margin.quantize(D(places), rounding=decimal.ROUND_HALF_UP)
    return f"{display}%"


def daterange(start: dt.date, end_inclusive: dt.date) -> list[dt.date]:
    days: list[dt.date] = []
    cursor = start
    while cursor <= end_inclusive:
        days.append(cursor)
        cursor += dt.timedelta(days=1)
    return days


def chunk_dates(start: dt.date, end_inclusive: dt.date, days: int) -> list[tuple[dt.date, dt.date]]:
    chunks: list[tuple[dt.date, dt.date]] = []
    cursor = start
    while cursor <= end_inclusive:
        chunk_end = min(cursor + dt.timedelta(days=days - 1), end_inclusive)
        chunks.append((cursor, chunk_end))
        cursor = chunk_end + dt.timedelta(days=1)
    return chunks
