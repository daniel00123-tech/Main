from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping


class ConfigurationError(ValueError):
    """Raised when required bot configuration is missing or invalid."""


@dataclass(frozen=True)
class BotConfig:
    base_url: str
    client_id: str
    client_secret: str
    customer_id: str
    token_url: str
    completed_statuses: tuple[str, ...]
    status_field: str
    further_action_field: str
    actioned_field: str
    actioned_value: str
    page_size: int
    timeout_seconds: float

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "BotConfig":
        source = env if env is not None else os.environ

        return cls(
            base_url=_required(source, "BIGCHANGE_BASE_URL").rstrip("/"),
            client_id=_required(source, "BIGCHANGE_CLIENT_ID"),
            client_secret=_required(source, "BIGCHANGE_CLIENT_SECRET"),
            customer_id=_required(source, "BIGCHANGE_CUSTOMER_ID"),
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
        )


def _required(env: Mapping[str, str], name: str) -> str:
    value = env.get(name)
    if not value:
        raise ConfigurationError(f"{name} is required")
    return value


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
