from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Mapping


class ConfigurationError(ValueError):
    """Raised when required bot configuration is missing or invalid."""


@dataclass(frozen=True)
class BotConfig:
    auth_mode: str
    base_url: str
    client_id: str | None
    client_secret: str | None
    customer_id: str | None
    api_key: str | None
    username: str | None
    password: str | None
    token_url: str
    completed_statuses: tuple[str, ...]
    status_field: str
    further_action_field: str
    actioned_field: str
    actioned_value: str
    page_size: int
    timeout_seconds: float
    lookback_days: int

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "BotConfig":
        source = env if env is not None else os.environ
        auth_mode = source.get("BIGCHANGE_AUTH_MODE") or (
            "api_key" if source.get("BIGCHANGE_API_KEY") else "oauth"
        )
        auth_mode = auth_mode.strip().lower()
        if auth_mode not in {"oauth", "api_key"}:
            raise ConfigurationError("BIGCHANGE_AUTH_MODE must be 'oauth' or 'api_key'")

        return cls(
            auth_mode=auth_mode,
            base_url=_required(source, "BIGCHANGE_BASE_URL").rstrip("/"),
            client_id=_required_for_mode(source, "BIGCHANGE_CLIENT_ID", auth_mode, "oauth"),
            client_secret=_required_for_mode(source, "BIGCHANGE_CLIENT_SECRET", auth_mode, "oauth"),
            customer_id=source.get("BIGCHANGE_CUSTOMER_ID"),
            api_key=_required_for_mode(source, "BIGCHANGE_API_KEY", auth_mode, "api_key"),
            username=_required_for_mode(source, "BIGCHANGE_USERNAME", auth_mode, "api_key"),
            password=_required_for_mode(source, "BIGCHANGE_PASSWORD", auth_mode, "api_key"),
            token_url=source.get("BIGCHANGE_TOKEN_URL", "https://auth.bigchange.com/connect/token"),
            completed_statuses=_csv(source.get("BIGCHANGE_COMPLETED_STATUSES", "Completed,Complete")),
            status_field=source.get("BIGCHANGE_STATUS_FIELD", "status"),
            further_action_field=source.get(
                "BIGCHANGE_FURTHER_ACTION_FIELD",
                "furtherActionRequired",
            ),
            actioned_field=source.get("BIGCHANGE_ACTIONED_FIELD", "actioned"),
            actioned_value=source.get("BIGCHANGE_ACTIONED_VALUE", "true"),
            page_size=_positive_int(source.get("BIGCHANGE_PAGE_SIZE", "100"), "BIGCHANGE_PAGE_SIZE"),
            timeout_seconds=float(source.get("BIGCHANGE_TIMEOUT_SECONDS", "30")),
            lookback_days=_positive_int(source.get("BIGCHANGE_LOOKBACK_DAYS", "14"), "BIGCHANGE_LOOKBACK_DAYS"),
        )

    @property
    def legacy_start_date(self) -> str:
        return (datetime.now(UTC) - timedelta(days=self.lookback_days)).strftime("%Y-%m-%d")

    @property
    def legacy_end_date(self) -> str:
        return datetime.now(UTC).strftime("%Y-%m-%d")


def _required(env: Mapping[str, str], name: str) -> str:
    value = env.get(name)
    if not value:
        raise ConfigurationError(f"{name} is required")
    return value


def _required_for_mode(
    env: Mapping[str, str],
    name: str,
    auth_mode: str,
    required_mode: str,
) -> str | None:
    if auth_mode != required_mode:
        return env.get(name)
    return _required(env, name)


def _csv(value: str) -> tuple[str, ...]:
    values = tuple(item.strip() for item in value.split(",") if item.strip())
    if not values:
        raise ConfigurationError("BIGCHANGE_COMPLETED_STATUSES must contain at least one status")
    return values


def _positive_int(value: str, name: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise ConfigurationError(f"{name} must be an integer") from exc

    if parsed < 1:
        raise ConfigurationError(f"{name} must be greater than zero")
    return parsed
