"""Small BigChange JobWatch web-service client for local prototypes.

The uploaded JobWatch Web Services PDF documents the legacy endpoint as:
https://webservice.bigchange.com/v01/services.ashx

Authentication uses HTTP Basic Auth plus a company key supplied either as an
HTTP header or a query-string parameter.
"""

from __future__ import annotations

import base64
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_BASE_URL = "https://webservice.bigchange.com/v01/services.ashx"


class BigChangeConfigError(RuntimeError):
    """Raised when required BigChange connection settings are missing."""


@dataclass(frozen=True)
class BigChangeConfig:
    base_url: str
    username: str
    password: str
    company_key: str
    key_location: str = "header"
    key_name: str = "key"
    timeout_seconds: float = 30.0

    @classmethod
    def from_env(cls) -> "BigChangeConfig":
        missing = [
            name
            for name in (
                "BIGCHANGE_USERNAME",
                "BIGCHANGE_PASSWORD",
                "BIGCHANGE_COMPANY_KEY",
            )
            if not os.environ.get(name)
        ]
        if missing:
            raise BigChangeConfigError(
                "Missing required environment variables: " + ", ".join(missing)
            )

        key_location = os.environ.get("BIGCHANGE_KEY_LOCATION", "header").lower()
        if key_location not in {"header", "query"}:
            raise BigChangeConfigError(
                "BIGCHANGE_KEY_LOCATION must be either 'header' or 'query'"
            )

        try:
            timeout_seconds = float(os.environ.get("BIGCHANGE_TIMEOUT_SECONDS", "30"))
        except ValueError as exc:
            raise BigChangeConfigError(
                "BIGCHANGE_TIMEOUT_SECONDS must be a number"
            ) from exc

        return cls(
            base_url=os.environ.get("BIGCHANGE_BASE_URL", DEFAULT_BASE_URL),
            username=os.environ["BIGCHANGE_USERNAME"],
            password=os.environ["BIGCHANGE_PASSWORD"],
            company_key=os.environ["BIGCHANGE_COMPANY_KEY"],
            key_location=key_location,
            key_name=os.environ.get("BIGCHANGE_KEY_NAME", "key"),
            timeout_seconds=timeout_seconds,
        )


class BigChangeClient:
    def __init__(self, config: BigChangeConfig):
        self.config = config

    def call(self, action: str, **params: Any) -> Any:
        query_params = {"Action": action, "Format": "JSON", **params}
        headers = {
            "Authorization": self._basic_auth_header(),
            "Accept": "application/json",
            "User-Agent": "cursor-bigchange-prototype/0.1",
        }

        if self.config.key_location == "header":
            headers[self.config.key_name] = self.config.company_key
        else:
            query_params[self.config.key_name] = self.config.company_key

        url = self._build_url(query_params)
        request = urllib.request.Request(url, headers=headers, method="GET")

        try:
            with urllib.request.urlopen(
                request, timeout=self.config.timeout_seconds
            ) as response:
                body = response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            error_body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(
                f"BigChange HTTP error {exc.code}: {error_body[:500]}"
            ) from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Could not reach BigChange: {exc.reason}") from exc

        return _parse_response(body)

    def _build_url(self, params: dict[str, Any]) -> str:
        clean_params = {
            key: str(value)
            for key, value in params.items()
            if value is not None and value != ""
        }
        separator = "&" if urllib.parse.urlparse(self.config.base_url).query else "?"
        return self.config.base_url + separator + urllib.parse.urlencode(clean_params)

    def _basic_auth_header(self) -> str:
        token = f"{self.config.username}:{self.config.password}".encode("utf-8")
        return "Basic " + base64.b64encode(token).decode("ascii")


def load_dotenv(path: Path = Path(".env")) -> None:
    """Load simple KEY=VALUE lines from .env if present.

    This intentionally keeps parsing small and dependency-free for the initial
    prototype. Environment variables already set by the shell take precedence.
    """

    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("'\""))


def _parse_response(body: str) -> Any:
    stripped = body.strip()
    if not stripped:
        return ""

    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        return stripped


def format_response_for_display(response: Any) -> str:
    if isinstance(response, str):
        return response
    return json.dumps(response, indent=2)


def get_service_code(response: Any) -> int | None:
    if isinstance(response, dict):
        value = response.get("Code")
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    if isinstance(response, str):
        json_match = re.search(r"Code\s*:\s*(-?\d+)", response)
        if json_match:
            return int(json_match.group(1))

        xml_match = re.search(r"<Code>\s*(-?\d+)\s*</Code>", response, re.IGNORECASE)
        if xml_match:
            return int(xml_match.group(1))

    return None


def is_success_response(response: Any) -> bool:
    code = get_service_code(response)
    # Some read endpoints return data directly rather than the Code/Result wrapper.
    return code is None or code == 0
