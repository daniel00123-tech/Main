"""HTTP client for BigChange's legacy Web Services API."""

from __future__ import annotations

import base64
import json
import time
from typing import Any, Mapping
from urllib import error, parse, request

from .config import BigChangeConfig

JsonObject = dict[str, Any]

DEFAULT_TIMEOUT_SECONDS = 90.0
DEFAULT_ATTEMPTS = 3


class BigChangeApiError(RuntimeError):
    """Raised when the BigChange API returns an error or invalid response."""


class BigChangeClient:
    """Small stdlib client for the legacy services.ashx endpoint."""

    def __init__(
        self,
        config: BigChangeConfig,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        attempts: int = DEFAULT_ATTEMPTS,
    ) -> None:
        self._config = config
        self._timeout = timeout
        self._attempts = max(1, attempts)

    def list_jobs(
        self,
        *,
        start: str,
        end: str,
        page: int,
        page_size: int,
        include_custom_fields: bool = True,
        unactioned: bool = True,
    ) -> list[JsonObject]:
        response = self._get(
            {
                "action": "JobsList",
                "Start": start,
                "End": end,
                "Page": str(page),
                "PageSize": str(page_size),
                "IncludeCustomFields": _legacy_bool(include_custom_fields),
                "Unactioned": "1" if unactioned else "0",
            }
        )
        result = response.get("Result")
        if result == "No results" or result is None:
            return []
        if not isinstance(result, list):
            raise BigChangeApiError(f"Unexpected JobsList result shape: {type(result).__name__}")
        return [job for job in result if isinstance(job, dict)]

    def save_back_office_note(
        self,
        *,
        job_id: str | int,
        actioned_value: str,
        notes: str,
    ) -> JsonObject:
        return self._get(
            {
                "action": "JobSaveBackOfficeNote",
                "JobId": str(job_id),
                "Actioned": actioned_value,
                "Notes": notes,
            }
        )

    def _get(self, params: Mapping[str, str]) -> JsonObject:
        url = f"{self._config.base_url}?{parse.urlencode(params)}"
        req = request.Request(url=url, method="GET", headers=self._headers())
        body = self._read_response(req)

        try:
            payload = json.loads(body)
        except json.JSONDecodeError as exc:
            raise BigChangeApiError("BigChange API returned invalid JSON") from exc

        if not isinstance(payload, dict):
            raise BigChangeApiError("BigChange API returned a non-object JSON payload")

        code = payload.get("Code")
        if code not in (0, "0"):
            result = payload.get("Result", "unknown error")
            raise BigChangeApiError(f"BigChange API error Code={code}: {result}")
        return payload

    def _read_response(self, req: request.Request) -> str:
        last_error: BigChangeApiError | None = None
        for attempt in range(self._attempts):
            try:
                with request.urlopen(req, timeout=self._timeout) as response:
                    return response.read().decode("utf-8")
            except error.HTTPError as exc:
                raise BigChangeApiError(f"HTTP {exc.code} from BigChange API") from exc
            except TimeoutError as exc:
                last_error = BigChangeApiError("BigChange API timed out")
                last_error.__cause__ = exc
            except error.URLError as exc:
                last_error = BigChangeApiError(f"Unable to reach BigChange API: {exc.reason}")
                last_error.__cause__ = exc
            if attempt < self._attempts - 1:
                time.sleep(2**attempt)
        assert last_error is not None
        raise last_error

    def _headers(self) -> dict[str, str]:
        credentials = f"{self._config.username}:{self._config.password}".encode("utf-8")
        token = base64.b64encode(credentials).decode("ascii")
        return {
            "Authorization": f"Basic {token}",
            "key": self._config.api_key,
            "Accept": "application/json",
            "Content-Type": "application/json",
        }


def _legacy_bool(value: bool) -> str:
    return "true" if value else "false"
