from __future__ import annotations

from typing import Any

import requests

from .config import BotConfig


class BigChangeApiError(RuntimeError):
    """Raised when BigChange returns an unexpected API response."""


class BigChangeClient:
    """Small REST client for the BigChange API.

    BigChange tenant schemas can differ, so status and custom field names are
    supplied by configuration and request/response bodies stay intentionally
    transparent.
    """

    def __init__(self, config: BotConfig, session: requests.Session | None = None) -> None:
        self._config = config
        self._session = session or requests.Session()
        self._access_token: str | None = None

    def iter_completed_jobs(self, *, limit: int | None = None) -> list[dict[str, Any]]:
        params = {
            "status": ",".join(self._config.completed_statuses),
            "limit": self._config.page_size,
        }
        jobs: list[dict[str, Any]] = []
        next_url: str | None = f"{self._config.base_url}/jobs"

        while next_url:
            payload = self._request("GET", next_url, params=params if next_url.endswith("/jobs") else None)
            items = self._extract_items(payload)
            for item in items:
                jobs.append(item)
                if limit is not None and len(jobs) >= limit:
                    return jobs
            next_url = self._extract_next_url(payload)
            params = None

        return jobs

    def mark_job_actioned(self, job_id: str, payload: dict[str, Any]) -> None:
        self._request("PATCH", f"{self._config.base_url}/jobs/{job_id}", json=payload)

    def _request(self, method: str, url: str, **kwargs: Any) -> Any:
        headers = kwargs.pop("headers", {})
        headers.update(self._auth_headers())

        response = self._session.request(
            method,
            url,
            headers=headers,
            timeout=self._config.timeout_seconds,
            **kwargs,
        )
        if response.status_code >= 400:
            raise BigChangeApiError(f"BigChange {method} {url} failed: {response.status_code} {response.text}")

        if response.status_code == 204 or not response.content:
            return {}

        return response.json()

    def _auth_headers(self) -> dict[str, str]:
        if not self._access_token:
            self._access_token = self._fetch_access_token()

        return {
            "Authorization": f"Bearer {self._access_token}",
            "customer-id": self._config.customer_id,
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

    def _fetch_access_token(self) -> str:
        response = self._session.post(
            self._config.token_url,
            data={
                "grant_type": "client_credentials",
                "client_id": self._config.client_id,
                "client_secret": self._config.client_secret,
            },
            timeout=self._config.timeout_seconds,
        )
        if response.status_code >= 400:
            raise BigChangeApiError(f"BigChange OAuth failed: {response.status_code} {response.text}")

        payload = response.json()
        token = payload.get("access_token")
        if not token:
            raise BigChangeApiError("BigChange OAuth response did not include access_token")
        return str(token)

    @staticmethod
    def _extract_items(payload: Any) -> list[dict[str, Any]]:
        if isinstance(payload, list):
            return payload
        if isinstance(payload, dict):
            for key in ("items", "data", "jobs", "results"):
                value = payload.get(key)
                if isinstance(value, list):
                    return value
        raise BigChangeApiError("Unable to find jobs list in BigChange response")

    @staticmethod
    def _extract_next_url(payload: Any) -> str | None:
        if not isinstance(payload, dict):
            return None

        links = payload.get("links")
        if isinstance(links, dict) and isinstance(links.get("next"), str):
            return links["next"]

        next_url = payload.get("next")
        return next_url if isinstance(next_url, str) else None
