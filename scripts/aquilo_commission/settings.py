"""Aquilo-only configuration. Never read other companies' env or caches."""

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
COMPANY_NAME = "Aquilo"
LABOUR_RATE = D("37.50")
ANOMALY_SALE = D("250")
MIN_PO_AMOUNT = D("1")
MONTHLY_MIN_PROFIT = D("11000")
MONTHLY_MIN_MARGIN_MESSAGE = D("25")  # Scorecard messaging only; does not gate.
DEFAULT_BASE_URL = "https://webservice.bigchange.com/v01/services.ashx"
DEFAULT_CACHE_DIR = Path("/tmp/aquilo_commission")

# Preview inboxes only until go-live. Real AM addresses are never used unless
# AQUILO_COMMISSION_GO_LIVE=1 is set explicitly.
PREVIEW_TO_ALLOWLIST = frozenset({"daniel.dwyer123@gmail.com"})
PREVIEW_CC_ALLOWLIST = frozenset({"daniel.dwyer@nirvana-group.co.uk"})

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

STAFF = {
    "isabel": {"name": "Isabel Strong", "category_id": 79691, "key": "isabel"},
    "laura": {"name": "Laura Menegon", "category_id": 129522, "key": "laura"},
    "amy": {"name": "Amy Bradley", "category_id": 79850, "key": "amy"},
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
        values[key] = _clean(value.strip())
    return values


def _aquilo_env_paths(source: Mapping[str, str]) -> list[Path]:
    paths: list[Path] = []
    explicit = source.get("AQUILO_ENV_FILE") or source.get("AQUILO_BIGCHANGE_ENV_FILE")
    if explicit:
        paths.append(Path(explicit).expanduser())
    return paths


def load_isolated_env(env: Mapping[str, str] | None = None) -> dict[str, str]:
    """Load Aquilo credentials only.

    Precedence: AQUILO_ENV_FILE, then process env. Prefers AQUILO_* keys so
    shared BIGCHANGE_* / SMTP_* values from other companies are not used
    unless no Aquilo-prefixed value exists in this dedicated process.
    """
    source = dict(os.environ if env is None else env)
    loaded: dict[str, str] = {}
    for path in _aquilo_env_paths(source):
        if path.is_file():
            loaded.update(_parse_env_file(path))
    loaded.update(source)
    return loaded


def env_get(env: Mapping[str, str], *names: str, default: str = "") -> str:
    for name in names:
        value = env.get(name)
        if value is not None and str(value).strip() != "":
            return str(value).strip()
    return default


def required(env: Mapping[str, str], *names: str) -> str:
    value = env_get(env, *names)
    if not value:
        raise ConfigError(f"Missing required Aquilo environment variable: {names[0]}")
    return value


@dataclass(frozen=True)
class AquiloSettings:
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
    to_email: str
    cc_email: str
    cache_dir: Path
    go_live: bool


def load_settings(env: Mapping[str, str] | None = None) -> AquiloSettings:
    raw = load_isolated_env(env)
    auth_mode = env_get(raw, "AQUILO_BIGCHANGE_AUTH_MODE", "BIGCHANGE_AUTH_MODE", default="api_key").lower()
    if auth_mode != "api_key":
        raise ConfigError("Aquilo JobWatch client supports BIGCHANGE_AUTH_MODE=api_key only")
    cache_dir = Path(
        env_get(raw, "AQUILO_CACHE_DIR", default=str(DEFAULT_CACHE_DIR))
    ).expanduser()
    go_live = env_get(raw, "AQUILO_COMMISSION_GO_LIVE", default="").lower() in {"1", "true", "yes"}
    return AquiloSettings(
        auth_mode=auth_mode,
        base_url=env_get(
            raw,
            "AQUILO_BIGCHANGE_BASE_URL",
            "BIGCHANGE_BASE_URL",
            default=DEFAULT_BASE_URL,
        )
        or DEFAULT_BASE_URL,
        api_key=required(raw, "AQUILO_BIGCHANGE_API_KEY", "BIGCHANGE_API_KEY"),
        username=required(raw, "AQUILO_BIGCHANGE_USERNAME", "BIGCHANGE_USERNAME"),
        password=required(raw, "AQUILO_BIGCHANGE_PASSWORD", "BIGCHANGE_PASSWORD"),
        smtp_host=required(raw, "AQUILO_SMTP_HOST", "SMTP_HOST"),
        smtp_port=int(env_get(raw, "AQUILO_SMTP_PORT", "SMTP_PORT", default="587")),
        smtp_username=required(raw, "AQUILO_SMTP_USERNAME", "SMTP_USERNAME"),
        smtp_password=required(raw, "AQUILO_SMTP_PASSWORD", "SMTP_PASSWORD"),
        from_email=required(raw, "AQUILO_SMTP_FROM_EMAIL", "SMTP_FROM_EMAIL"),
        from_name=env_get(raw, "AQUILO_SMTP_FROM_NAME", "SMTP_FROM_NAME", default="Daniel Dwyer"),
        to_email=env_get(raw, "AQUILO_SMTP_TO_EMAIL", "SMTP_TO_EMAIL", default="daniel.dwyer123@gmail.com"),
        cc_email=env_get(raw, "AQUILO_SMTP_CC_EMAIL", "SMTP_CC_EMAIL", default=""),
        cache_dir=cache_dir,
        go_live=go_live,
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
