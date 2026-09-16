"""Configuration loading for the BigChange actioner."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import os
from typing import Mapping

DEFAULT_BASE_URL = "https://webservice.bigchange.com/v01/services.ashx"
DEFAULT_COMPLETED_STATUSES = ("Completed", "Completed with issues")
DEFAULT_ACTION_RESULT_VALUES = ("Complete", "Completed")


class ConfigError(ValueError):
    """Raised when required BigChange configuration is missing or invalid."""


@dataclass(frozen=True)
class BigChangeConfig:
    """Runtime configuration for legacy API-key/login authentication."""

    auth_mode: str
    base_url: str
    api_key: str
    username: str
    password: str
    lookback_days: int
    page_size: int
    completed_statuses: tuple[str, ...]
    status_field: str
    actioned_field: str
    action_result_field: str
    action_result_values: tuple[str, ...]
    action_note: str
    actioned_request_value: str


def load_config(env: Mapping[str, str] | None = None) -> BigChangeConfig:
    """Load configuration from .env files and the process environment.

    Precedence from lowest to highest is:
    .env, .env.local, BIGCHANGE_ENV_FILE, then explicitly supplied/process env.
    """

    source_env = dict(os.environ if env is None else env)
    loaded_env = _load_env_files(source_env)
    loaded_env.update(source_env)

    auth_mode = loaded_env.get("BIGCHANGE_AUTH_MODE", "api_key").strip()
    if auth_mode != "api_key":
        raise ConfigError("Only BIGCHANGE_AUTH_MODE=api_key is supported for the legacy Web Services API")

    api_key = _required(loaded_env, "BIGCHANGE_API_KEY")
    username = _required(loaded_env, "BIGCHANGE_USERNAME")
    password = _required(loaded_env, "BIGCHANGE_PASSWORD")

    return BigChangeConfig(
        auth_mode=auth_mode,
        base_url=loaded_env.get("BIGCHANGE_BASE_URL", DEFAULT_BASE_URL).strip() or DEFAULT_BASE_URL,
        api_key=api_key,
        username=username,
        password=password,
        lookback_days=_positive_int(loaded_env, "BIGCHANGE_LOOKBACK_DAYS", 14),
        page_size=_positive_int(loaded_env, "BIGCHANGE_PAGE_SIZE", 500),
        completed_statuses=_csv(
            loaded_env.get("BIGCHANGE_COMPLETED_STATUSES"),
            DEFAULT_COMPLETED_STATUSES,
        ),
        status_field=loaded_env.get("BIGCHANGE_STATUS_FIELD", "Status").strip() or "Status",
        actioned_field=loaded_env.get("BIGCHANGE_ACTIONED_FIELD", "Actioned").strip() or "Actioned",
        action_result_field=loaded_env.get("BIGCHANGE_ACTION_RESULT_FIELD", "StatusComment").strip()
        or "StatusComment",
        action_result_values=_csv(
            loaded_env.get("BIGCHANGE_ACTION_RESULT_VALUES"),
            DEFAULT_ACTION_RESULT_VALUES,
        ),
        action_note=loaded_env.get(
            "BIGCHANGE_ACTION_NOTE",
            "Marked actioned by automation",
        ),
        actioned_request_value=loaded_env.get("BIGCHANGE_ACTIONED_REQUEST_VALUE", "1").strip() or "1",
    )


def _load_env_files(env: Mapping[str, str]) -> dict[str, str]:
    values: dict[str, str] = {}
    for path in _env_paths(env):
        if path.is_file():
            values.update(_parse_env_file(path))
    return values


def _env_paths(env: Mapping[str, str]) -> list[Path]:
    paths = [Path(".env"), Path(".env.local")]
    explicit = env.get("BIGCHANGE_ENV_FILE")
    if explicit:
        paths.append(Path(explicit).expanduser())
    return paths


def _parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key.startswith("#"):
            continue
        values[key] = _clean_env_value(value.strip())
    return values


def _clean_env_value(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def _required(env: Mapping[str, str], key: str) -> str:
    value = env.get(key, "").strip()
    if not value:
        raise ConfigError(f"Missing required environment variable: {key}")
    return value


def _positive_int(env: Mapping[str, str], key: str, default: int) -> int:
    raw_value = env.get(key)
    if raw_value is None or raw_value.strip() == "":
        return default
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise ConfigError(f"{key} must be an integer") from exc
    if value < 1:
        raise ConfigError(f"{key} must be greater than zero")
    return value


def _csv(value: str | None, default: tuple[str, ...]) -> tuple[str, ...]:
    if value is None:
        return default
    items = tuple(item.strip() for item in value.split(",") if item.strip())
    return items or default
