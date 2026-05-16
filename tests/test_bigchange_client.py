from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import pytest
import responses

from bigchange_actioner.bigchange import BigChangeApiError, BigChangeClient
from bigchange_actioner.config import BotConfig


def make_legacy_config(**overrides: object) -> BotConfig:
    defaults = {
        "auth_mode": "api_key",
        "base_url": "https://webservice.example.test/v01/services.ashx",
        "client_id": None,
        "client_secret": None,
        "customer_id": None,
        "api_key": "company-api-key",
        "username": "user@example.test",
        "password": "password",
        "token_url": "https://auth.example.test/token",
        "completed_statuses": ("Completed", "Complete"),
        "status_field": "status",
        "further_action_field": "furtherActionRequired",
        "actioned_field": "actioned",
        "actioned_value": "true",
        "page_size": 2,
        "timeout_seconds": 30.0,
        "lookback_days": 14,
    }
    defaults.update(overrides)
    return BotConfig(**defaults)


@responses.activate
def test_api_key_mode_uses_legacy_jobslist_request() -> None:
    responses.add(
        responses.GET,
        "https://webservice.example.test/v01/services.ashx",
        json={
            "Code": 0,
            "Result": [
                {"JobId": 1, "Status": "Completed", "Actioned": False},
                {"JobId": 2, "Status": "Completed", "Actioned": False},
            ],
        },
    )

    jobs = BigChangeClient(make_legacy_config()).iter_completed_jobs(limit=2)

    assert [job["JobId"] for job in jobs] == [1, 2]
    request = responses.calls[0].request
    query = parse_qs(urlparse(request.url).query)
    assert query["action"] == ["JobsList"]
    assert query["Page"] == ["0"]
    assert query["PageSize"] == ["2"]
    assert query["IncludeCustomFields"] == ["true"]
    assert query["Unactioned"] == ["1"]


def test_api_key_mode_does_not_execute_without_confirmed_legacy_update_endpoint() -> None:
    with pytest.raises(BigChangeApiError, match="Legacy API-key mode can list jobs"):
        BigChangeClient(make_legacy_config()).mark_job_actioned("1", {"Actioned": True})
