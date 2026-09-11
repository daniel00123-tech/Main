"""Fail closed if runtime config belongs to a former-company environment.

Nirvana, Aquilo and Urban Maintenance credentials, email destinations and
live API endpoints must never be used. Integration code and schemas may be
kept as technical reference for Caddington, HT Business and EL Business.
"""

from __future__ import annotations

import os
import re
from typing import Mapping

FORMER_COMPANY_MARKERS = (
    "nirvana",
    "aquilo",
    "urban maintenance",
    "urban-maintenance",
    "urban_maintenance",
    "urbanmaintenance",
    "nirvana-group",
    "nirvana-maintenance",
)

FORMER_COMPANY_EMAIL_DOMAINS = (
    "nirvana-group.co.uk",
    "nirvana-maintenance.co.uk",
)

# Destination / credential environment variables that can send data or authenticate.
SENSITIVE_ENV_NAMES = {
    "BIGCHANGE_AUTH_MODE",
    "BIGCHANGE_BASE_URL",
    "BIGCHANGE_USERNAME",
    "BIGCHANGE_PASSWORD",
    "BIGCHANGE_API_KEY",
    "FRESHDESK_SUBDOMAIN",
    "FRESHDESK_API_KEY",
    "FIXFLO_BASE_URL",
    "FIXFLO_API_KEY",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USERNAME",
    "SMTP_PASSWORD",
    "SMTP_FROM_EMAIL",
    "SMTP_FROM_NAME",
    "SMTP_TO_EMAIL",
    "SMTP_CC_EMAIL",
    "SMTP_BCC_EMAIL",
}

SENSITIVE_NAME_SUBSTRINGS = (
    "WEBHOOK",
    "CALLBACK",
    "CLIENT_SECRET",
    "CLIENT_ID",
    "REFRESH_TOKEN",
    "ACCESS_TOKEN",
    "API_KEY",
    "API_TOKEN",
    "OAUTH",
    "GRAPH",
    "OUTLOOK",
    "AZURE",
    "ENTRA",
    "MICROSOFT",
    "MSGRAPH",
    "BIGCHANGE",
    "FRESHDESK",
    "FIXFLO",
    "FIXFLOW",
    "SMTP_",
    "_SMTP",
    "MAIL_",
    "_EMAIL",
    "EMAIL_",
)


class FormerCompanyAccessError(RuntimeError):
    """Raised when configuration would authenticate or send data to a former company."""


def _normalized(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().lower())


def describe_former_company_hit(text: str) -> str | None:
    """Return a marker name if text is associated with a former company, else None.

    Does not return the original secret value.
    """
    if not text:
        return None
    lowered = _normalized(text)
    compact = re.sub(r"[^a-z0-9]+", "", lowered)
    for domain in FORMER_COMPANY_EMAIL_DOMAINS:
        if domain in lowered:
            return domain
    for marker in FORMER_COMPANY_MARKERS:
        marker_norm = _normalized(marker)
        marker_compact = re.sub(r"[^a-z0-9]+", "", marker_norm)
        if marker_norm in lowered or marker_compact in compact:
            return marker
    return None


def is_sensitive_env_name(name: str) -> bool:
    upper = name.upper()
    if upper in SENSITIVE_ENV_NAMES:
        return True
    if describe_former_company_hit(name):
        return True
    return any(part in upper for part in SENSITIVE_NAME_SUBSTRINGS)


def reject_former_company_value(name: str, value: str | None) -> None:
    if value is None or value == "":
        return
    hit = describe_former_company_hit(name) or describe_former_company_hit(value)
    if hit:
        raise FormerCompanyAccessError(
            f"{name} is blocked because it is associated with a former-company environment "
            f"({hit}). Use credentials explicitly identified as Caddington, HT Business or "
            f"EL Business. If ownership is uncertain, fail closed and ask Daniel."
        )


def reject_former_company_environment(environ: Mapping[str, str] | None = None) -> None:
    """Scan credential/destination environment variables and fail closed on former-company hits."""
    env = os.environ if environ is None else environ
    for name, value in env.items():
        if not is_sensitive_env_name(name):
            continue
        reject_former_company_value(name, value)
