"""Manager scorecard configuration.

Change the block below to retarget the report. Teams stay company-specific:
Nirvana staff are never mixed with Aquilo staff.

CC is configuration-driven. Set NIRVANA_SMTP_CC_EMAIL to override the address
below, including setting it to a blank value to send to the manager only.
"""

from __future__ import annotations

import datetime as dt
import os
import re
from dataclasses import dataclass
from decimal import Decimal
from typing import Mapping
from zoneinfo import ZoneInfo

from scripts.aquilo_commission.settings import MONTHLY_MIN_PROFIT as AQUILO_UK_STAFF_GATE
from scripts.nirvana_commission.settings import MONTHLY_MIN_PROFIT as NIRVANA_STAFF_GATE

# --- Change these to retarget the scorecard ---------------------------------
COMPANY = "Nirvana"
SCORECARD_HEADING = "Nirvana Management"
MANAGER_NAME = "Harry Thripp"
MANAGER_EMAIL = "daniel.dwyer123@gmail.com"
CC_EMAIL = "daniel.dwyer@nirvana-group.uk"
MANAGER_COMMISSION_RATE = Decimal("0.25")
MANAGER_MONTHLY_PROFIT_GATE_GBP = Decimal("40000")
REPORT_TIMEZONE = "Europe/London"
# preview: write the scorecard, do not email it.
# approved: allow a send only when --send is also passed and the CC domain resolves.
DELIVERY_MODE = "preview"

# Aquilo manager is configurable. Leave blank rather than invent a name.
AQUILO_SCORECARD_HEADING = "Aquilo Management"
AQUILO_MANAGER_NAME = ""
AQUILO_MANAGER_EMAIL = ""
AQUILO_CC_EMAIL = ""

NIRVANA_ACCOUNT_MANAGERS = ("abi", "amy", "olivia", "hazel")
AQUILO_UK_ACCOUNT_MANAGERS = ("isabel", "laura", "amy")
AQUILO_SA_ACCOUNT_MANAGERS = ("kayla",)
# -----------------------------------------------------------------------------

LONDON = ZoneInfo(REPORT_TIMEZONE)
# Staff reports already deliver to this domain. nirvana-group.uk does not resolve.
VERIFIED_CC_DOMAIN = "nirvana-group.co.uk"
UNRESOLVED_CC_DOMAIN = "nirvana-group.uk"

STAFF_INBOX_DOMAINS = frozenset(
    {
        "nirvana-maintenance.co.uk",
        "aquilofacilities.co.uk",
    }
)


class ConfigError(RuntimeError):
    pass


def _clean(value: str | None) -> str:
    text = str(value or "").strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {"'", '"'}:
        return text[1:-1].strip()
    return text


def resolve_cc(env: Mapping[str, str] | None = None, *, script_cc: str = CC_EMAIL) -> str:
    """Return the CC address.

    A present NIRVANA_SMTP_CC_EMAIL wins, even when it is blank. A blank value
    means send to the manager only. When the variable is absent, the script
    constant above is used so the address stays easy to change in one place.
    """
    source = os.environ if env is None else env
    if "NIRVANA_SMTP_CC_EMAIL" in source:
        return _clean(source.get("NIRVANA_SMTP_CC_EMAIL"))
    return _clean(script_cc)


def resolve_delivery(env: Mapping[str, str] | None = None) -> str:
    source = os.environ if env is None else env
    if "MANAGER_COMMISSION_DELIVERY" in source:
        mode = _clean(source.get("MANAGER_COMMISSION_DELIVERY")).lower()
        return mode or "preview"
    return DELIVERY_MODE


def company_key(name: str) -> str:
    key = _clean(name).lower().replace(" ", "-")
    if key in {"nirvana"}:
        return "nirvana"
    if key in {"aquilo", "aquilo-uk"}:
        return "aquilo"
    raise ConfigError("Manager scorecard company must be Nirvana or Aquilo")


@dataclass(frozen=True)
class ManagerTarget:
    company_key: str
    company_name: str
    heading: str
    manager_name: str
    manager_email: str
    cc_email: str
    rate: Decimal
    profit_gate: Decimal
    delivery_mode: str
    timezone: str


def target_for(company: str, env: Mapping[str, str] | None = None) -> ManagerTarget:
    key = company_key(company)
    if key == "nirvana":
        name = "Nirvana"
        heading = _clean(SCORECARD_HEADING) or "Nirvana Management"
        manager = _clean(MANAGER_NAME)
        email = _clean(MANAGER_EMAIL)
        script_cc = CC_EMAIL
    else:
        name = "Aquilo"
        heading = _clean(AQUILO_SCORECARD_HEADING) or "Aquilo Management"
        manager = _clean(AQUILO_MANAGER_NAME)
        email = _clean(AQUILO_MANAGER_EMAIL)
        script_cc = AQUILO_CC_EMAIL
        if not manager:
            raise ConfigError(
                "Set AQUILO_MANAGER_NAME at the top of scripts/manager_commission/config.py "
                "before building an Aquilo manager scorecard"
            )
    if not manager or not email:
        raise ConfigError("Manager name and email are required")
    rate = MANAGER_COMMISSION_RATE
    gate = MANAGER_MONTHLY_PROFIT_GATE_GBP
    if rate <= 0 or rate > 1:
        raise ConfigError("Manager commission rate must be between 0 and 1")
    if gate <= 0:
        raise ConfigError("Manager profit gate must be positive")
    return ManagerTarget(
        company_key=key,
        company_name=name,
        heading=heading,
        manager_name=manager,
        manager_email=email,
        cc_email=resolve_cc(env, script_cc=script_cc),
        rate=rate,
        profit_gate=gate,
        delivery_mode=resolve_delivery(env),
        timezone=REPORT_TIMEZONE,
    )


def london_today(today: dt.date | None = None) -> dt.date:
    if today is not None:
        return today
    return dt.datetime.now(LONDON).date()


def month_bounds(today: dt.date) -> tuple[dt.date, dt.date]:
    start = today.replace(day=1)
    if start.month == 12:
        end = dt.date(start.year + 1, 1, 1) - dt.timedelta(days=1)
    else:
        end = dt.date(start.year, start.month + 1, 1) - dt.timedelta(days=1)
    return start, end


def reporting_window(
    *,
    year: int = 0,
    month: int = 0,
    today: dt.date | None = None,
) -> tuple[dt.date, dt.date, dt.date]:
    current = london_today(today)
    if year and month:
        start, end = month_bounds(dt.date(year, month, 1))
    else:
        start, end = month_bounds(current)
    as_of = min(current, end) if current >= start else end
    return start, end, as_of


def month_label(start: dt.date) -> str:
    return start.strftime("%B %Y")


def long_date(day: dt.date) -> str:
    return f"{day.day} {day.strftime('%B %Y')}"


def period_id(company: str, manager: str, start: dt.date) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", manager.strip().lower()).strip("-")
    return f"{company}:{slug}:{start.strftime('%Y-%m')}"


def cc_domain(email: str) -> str:
    if "@" not in email:
        return ""
    return email.rsplit("@", 1)[-1].strip().lower()


def cc_domain_problem(email: str) -> str:
    """Explain why this CC must not be used for delivery. Blank when it is usable."""
    if not email:
        return ""
    domain = cc_domain(email)
    if not domain:
        return "CC address is not a valid email"
    if domain == UNRESOLVED_CC_DOMAIN:
        return (
            f"{email} uses {UNRESOLVED_CC_DOMAIN}, which does not resolve. "
            f"Existing staff reports copy {VERIFIED_CC_DOMAIN}. "
            "Delivery stays off until the CC domain is corrected."
        )
    return ""
