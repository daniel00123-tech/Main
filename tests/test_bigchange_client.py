from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import responses

from bigchange_actioner.bigchange import BigChangeClient
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
        "actioned_note": "Marked actioned by automation.",
        "action_result_field": "StatusComment",
        "action_result_values": ("Complete", "Completed"),
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


@responses.activate
def test_api_key_mode_marks_job_actioned_with_back_office_note() -> None:
    responses.add(
        responses.GET,
        "https://webservice.example.test/v01/services.ashx",
        json={"Code": 0},
    )

    BigChangeClient(make_legacy_config()).mark_job_actioned(
        "1",
        {"actioned": True, "note": "Actioned by test."},
    )

    request = responses.calls[0].request
    query = parse_qs(urlparse(request.url).query)
    assert query["action"] == ["JobSaveBackOfficeNote"]
    assert query["JobId"] == ["1"]
    assert query["Actioned"] == ["1"]
    assert query["Notes"] == ["Actioned by test."]
