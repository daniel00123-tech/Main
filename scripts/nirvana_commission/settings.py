"""Nirvana-only configuration.

Credentials come from NIRVANA_* process variables or NIRVANA_ENV_FILE outside
the repository. Other companies' BIGCHANGE_* / SMTP_* values are never read.
"""

from __future__ import annotations

import datetime as dt
import decimal
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping
from zoneinfo import ZoneInfo

D = decimal.Decimal

LONDON = ZoneInfo("Europe/London")
HISTORY_ANCHOR = dt.date(2026, 1, 1)
COMPANY_NAME = "Nirvana"
LABOUR_RATE = D("37.50")
ANOMALY_SALE = D("250")
MIN_PO_AMOUNT = D("1")
MONTHLY_MIN_PROFIT = D("11000")
MONTHLY_MIN_MARGIN_MESSAGE = D("40")
DEFAULT_BASE_URL = "https://webservice.bigchange.com/v01/services.ashx"
DEFAULT_CACHE_DIR = Path("/tmp/nirvana_commission")

# Temporary delivery override (spec section 10). Remove the env var to restore
# permanent per-employee routing. No other switch replaces it.
TEST_OVERRIDE_ENV = "NIRVANA_COMMISSION_TEST_OVERRIDE"
TEST_OVERRIDE_TO = "daniel.dwyer@nirvana-group.co.uk"

COMPLETED_STATUSES = frozenset({"completed", "completed with issues"})
CANCELLED_STATUSES = frozenset({"cancelled", "canceled", "deleted"})

EXEMPT_RESOURCE_GROUPS = frozenset(
    {
        "office",
        "subcontractor",
        "subcontractors",
        "sub contractor",
        "sub-contractor",
        "ex employee",
        "ex-employee",
        "exemployee",
    }
)
KNOWN_SUBCONTRACTOR_NEEDLES = (
    "essentialz",
    "essential maintenance",
)
IQBAL_NAME_NEEDLE = "iqbal"
ESSENTIALZ_PO_NEEDLES = (
    "essentialz",
    "essential maintenance",
    "essential maintenance limited",
    "essentialz maintenance",
    "iqbal",
)

# JobCategoryId values verified from the Nirvana BigChange tenant
# (action=JobCategories) on 2026-09-28. Do not copy these from another company.
STAFF = {
    "abi": {
        "name": "Abi Clements",
        "category_id": 128055,
        "key": "abi",
        "email": "abi.clements@nirvana-maintenance.co.uk",
    },
    "amy": {
        "name": "Amy Marshall",
        "category_id": 80404,
        "key": "amy",
        "email": "amy.marshall@nirvana-maintenance.co.uk",
    },
    "olivia": {
        "name": "Olivia Blakeway",
        "category_id": 65297,
        "key": "olivia",
        "email": "olivia.blakeway@nirvana-maintenance.co.uk",
    },
    "hazel": {
        "name": "Hazel Davey",
        "category_id": 132027,
        "key": "hazel",
        "email": "hazel.davey@nirvana-maintenance.co.uk",
    },
}
STAFF_BY_CATEGORY = {meta["category_id"]: meta for meta in STAFF.values()}


class ConfigError(RuntimeError):
    pass


def _clean(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def _parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key.startswith("#"):
            continue
        if not key.startswith("NIRVANA_"):
            continue
        values[key] = _clean(value.strip())
    return values


def load_isolated_env(env: Mapping[str, str] | None = None) -> dict[str, str]:
    """Load Nirvana credentials only. Never fall back to another company's keys."""
    source = dict(os.environ if env is None else env)
    loaded: dict[str, str] = {}
    explicit = source.get("NIRVANA_ENV_FILE")
    if explicit:
        path = Path(explicit).expanduser()
        if path.is_file():
            loaded.update(_parse_env_file(path))
    for key, value in source.items():
        if key.startswith("NIRVANA_") and value is not None and str(value).strip() != "":
            loaded[key] = str(value).strip()
    return loaded


def env_get(env: Mapping[str, str], name: str, default: str = "") -> str:
    value = env.get(name)
    if value is not None and str(value).strip() != "":
        return _clean(str(value).strip())
    return default


def required(env: Mapping[str, str], name: str) -> str:
    value = env_get(env, name)
    if not value:
        raise ConfigError(f"Missing required Nirvana environment variable: {name}")
    return value


@dataclass(frozen=True)
class NirvanaSettings:
    auth_mode: str
    base_url: str
    api_key: str
    username: str
    password: str
    smtp_host: str
    smtp_port: int
    smtp_username: str
    smtp_password: str
    from_email: str
    from_name: str
    cc_email: str
    cache_dir: Path
    test_override: bool


def load_settings(env: Mapping[str, str] | None = None) -> NirvanaSettings:
    raw = load_isolated_env(env)
    auth_mode = env_get(raw, "NIRVANA_BIGCHANGE_AUTH_MODE", default="api_key").lower()
    if auth_mode != "api_key":
        raise ConfigError("Nirvana JobWatch client supports NIRVANA_BIGCHANGE_AUTH_MODE=api_key only")
    for meta in STAFF.values():
        if not meta.get("category_id"):
            raise ConfigError(f"Missing JobCategoryId for {meta['name']}")
    cache_dir = Path(env_get(raw, "NIRVANA_CACHE_DIR", default=str(DEFAULT_CACHE_DIR))).expanduser()
    if cache_dir != DEFAULT_CACHE_DIR and not str(cache_dir).startswith("/tmp/nirvana_commission"):
        raise ConfigError("Nirvana cache must stay under /tmp/nirvana_commission")
    test_override = env_get(raw, TEST_OVERRIDE_ENV, default="") == "1"
    return NirvanaSettings(
        auth_mode=auth_mode,
        base_url=env_get(raw, "NIRVANA_BIGCHANGE_BASE_URL", default=DEFAULT_BASE_URL) or DEFAULT_BASE_URL,
        api_key=required(raw, "NIRVANA_BIGCHANGE_API_KEY"),
        username=required(raw, "NIRVANA_BIGCHANGE_USERNAME"),
        password=required(raw, "NIRVANA_BIGCHANGE_PASSWORD"),
        smtp_host=required(raw, "NIRVANA_SMTP_HOST"),
        smtp_port=int(env_get(raw, "NIRVANA_SMTP_PORT", default="587")),
        smtp_username=required(raw, "NIRVANA_SMTP_USERNAME"),
        smtp_password=required(raw, "NIRVANA_SMTP_PASSWORD"),
        from_email=required(raw, "NIRVANA_SMTP_FROM_EMAIL"),
        from_name=env_get(raw, "NIRVANA_SMTP_FROM_NAME", default="Daniel Dwyer"),
        cc_email=required(raw, "NIRVANA_SMTP_CC_EMAIL"),
        cache_dir=cache_dir,
        test_override=test_override,
    )


def report_month(today: dt.date | None = None) -> tuple[dt.date, dt.date]:
    now = today or dt.datetime.now(LONDON).date()
    start = now.replace(day=1)
    if start.month == 12:
        end = dt.date(start.year + 1, 1, 1) - dt.timedelta(days=1)
    else:
        end = dt.date(start.year, start.month + 1, 1) - dt.timedelta(days=1)
    return start, end


def inclusion_end(month_end: dt.date, today: dt.date | None = None) -> dt.date:
    now = today or dt.datetime.now(LONDON).date()
    return min(month_end, now)


def delivery_for(settings: NirvanaSettings, staff: Mapping[str, str]) -> tuple[str, str, str]:
    """Return (to_email, cc_email, subject_prefix).

    Section 10 overrides delivery only. Ownership and report content stay put.
    """
    if settings.test_override:
        return TEST_OVERRIDE_TO, "", "TEST — "
    return str(staff["email"]), settings.cc_email, ""
