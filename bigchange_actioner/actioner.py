"""Business rules for actioning completed BigChange jobs."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Protocol

from .client import BigChangeApiError, JsonObject
from .config import BigChangeConfig

FALSE_LIKE_ACTIONED_VALUES = {"", "0", "false", "no", "n", "none", "null"}


class BigChangeJobClient(Protocol):
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
        ...

    def save_back_office_note(
        self,
        *,
        job_id: str | int,
        actioned_value: str,
        notes: str,
    ) -> JsonObject:
        ...


@dataclass(frozen=True)
class ActionSummary:
    jobs_scanned: int
    jobs_actioned: int
    failures: int
    remaining_actionable_jobs: int

    def to_dict(self) -> dict[str, int]:
        return {
            "jobs_scanned": self.jobs_scanned,
            "jobs_actioned": self.jobs_actioned,
            "failures": self.failures,
            "remaining_actionable_jobs": self.remaining_actionable_jobs,
        }


def run_actioner(
    *,
    client: BigChangeJobClient,
    config: BigChangeConfig,
    execute: bool,
    today: date | None = None,
) -> ActionSummary:
    """Scan unactioned jobs and optionally mark eligible jobs actioned."""

    end_date = today or date.today()
    start_date = end_date - timedelta(days=config.lookback_days)
    jobs = _load_jobs(
        client=client,
        start=start_date.isoformat(),
        end=end_date.isoformat(),
        page_size=config.page_size,
    )

    actionable_jobs = [job for job in jobs if is_actionable_job(job, config)]
    failures = 0
    jobs_actioned = 0

    if execute:
        for job in actionable_jobs:
            job_id = job.get("JobId")
            if job_id in (None, ""):
                failures += 1
                continue
            try:
                client.save_back_office_note(
                    job_id=job_id,
                    actioned_value=config.actioned_request_value,
                    notes=config.action_note,
                )
            except BigChangeApiError:
                failures += 1
            else:
                jobs_actioned += 1

    remaining_actionable_jobs = len(actionable_jobs) - jobs_actioned
    return ActionSummary(
        jobs_scanned=len(jobs),
        jobs_actioned=jobs_actioned,
        failures=failures,
        remaining_actionable_jobs=remaining_actionable_jobs,
    )


def is_actionable_job(job: JsonObject, config: BigChangeConfig) -> bool:
    """Return True only for completed, unactioned jobs with safe result values."""

    status = _field_as_text(job.get(config.status_field))
    result = _field_as_text(job.get(config.action_result_field))
    actioned = job.get(config.actioned_field)

    return (
        _is_unactioned(actioned)
        and status in config.completed_statuses
        and result in config.action_result_values
    )


def _load_jobs(
    *,
    client: BigChangeJobClient,
    start: str,
    end: str,
    page_size: int,
) -> list[JsonObject]:
    jobs: list[JsonObject] = []
    page = 0
    while True:
        batch = client.list_jobs(
            start=start,
            end=end,
            page=page,
            page_size=page_size,
            include_custom_fields=True,
            unactioned=True,
        )
        jobs.extend(batch)
        if len(batch) < page_size:
            return jobs
        page += 1


def _is_unactioned(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, bool):
        return not value
    if isinstance(value, int | float):
        return value == 0
    return str(value).strip().lower() in FALSE_LIKE_ACTIONED_VALUES


def _field_as_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()
