from __future__ import annotations

from typing import Any

from bigchange_actioner.actioner import CompletedJobActioner
from bigchange_actioner.config import BotConfig


def make_config(**overrides: Any) -> BotConfig:
    defaults = {
        "base_url": "https://api.example.test/v1",
        "client_id": "client-id",
        "client_secret": "client-secret",
        "customer_id": "customer-id",
        "token_url": "https://auth.example.test/token",
        "completed_statuses": ("Completed", "Complete"),
        "status_field": "status",
        "further_action_field": "furtherActionRequired",
        "actioned_field": "actioned",
        "actioned_value": "true",
        "page_size": 100,
        "timeout_seconds": 30.0,
    }
    defaults.update(overrides)
    return BotConfig(**defaults)


class FakeClient:
    def __init__(self, jobs: list[dict[str, Any]]) -> None:
        self.jobs = jobs
        self.marked: list[tuple[str, dict[str, Any]]] = []

    def iter_completed_jobs(self, *, limit: int | None = None) -> list[dict[str, Any]]:
        return self.jobs[:limit]

    def mark_job_actioned(self, job_id: str, payload: dict[str, Any]) -> None:
        self.marked.append((job_id, payload))


def test_dry_run_identifies_completed_jobs_without_marking_them() -> None:
    client = FakeClient(
        [
            {"id": "1", "status": "Completed", "furtherActionRequired": False, "actioned": False},
            {"id": "2", "status": "Completed", "furtherActionRequired": True, "actioned": False},
            {"id": "3", "status": "In progress", "furtherActionRequired": False, "actioned": False},
            {"id": "4", "status": "Completed", "furtherActionRequired": False, "actioned": True},
        ]
    )
    actioner = CompletedJobActioner(client=client, config=make_config())

    summary = actioner.run(dry_run=True)

    assert summary.scanned == 4
    assert summary.actioned == 1
    assert summary.skipped == 3
    assert summary.dry_run is True
    assert client.marked == []


def test_execute_marks_only_completed_jobs_with_no_further_action_required() -> None:
    client = FakeClient(
        [
            {"jobId": 10, "status": "complete", "furtherActionRequired": "no", "actioned": "false"},
            {"jobId": 11, "status": "complete", "furtherActionRequired": "yes", "actioned": "false"},
            {"jobId": 12, "status": "complete", "furtherActionRequired": "no", "actioned": "true"},
        ]
    )
    actioner = CompletedJobActioner(client=client, config=make_config())

    summary = actioner.run(dry_run=False)

    assert summary.actioned == 1
    assert client.marked == [("10", {"actioned": True})]


def test_custom_field_shapes_are_supported() -> None:
    client = FakeClient(
        [
            {
                "id": "custom-1",
                "customFields": {
                    "jobStatus": "Completed",
                    "needsFollowUp": "false",
                    "bcActioned": "false",
                },
            }
        ]
    )
    actioner = CompletedJobActioner(
        client=client,
        config=make_config(
            status_field="jobStatus",
            further_action_field="needsFollowUp",
            actioned_field="bcActioned",
            actioned_value="Actioned",
        ),
    )

    summary = actioner.run(dry_run=False)

    assert summary.actioned == 1
    assert client.marked == [("custom-1", {"bcActioned": "Actioned"})]
