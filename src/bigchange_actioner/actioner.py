from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping

from .bigchange import BigChangeClient
from .config import BotConfig


@dataclass(frozen=True)
class JobDecision:
    job_id: str
    action: str
    reason: str
    job: Mapping[str, Any] = field(repr=False)


@dataclass(frozen=True)
class RunSummary:
    scanned: int
    actioned: int
    skipped: int
    dry_run: bool
    decisions: tuple[JobDecision, ...]


class CompletedJobActioner:
    def __init__(self, client: BigChangeClient, config: BotConfig):
        self._client = client
        self._config = config

    def run(self, *, dry_run: bool = True, limit: int | None = None) -> RunSummary:
        jobs = list(self._client.iter_completed_jobs(limit=limit))
        decisions = tuple(self.decide(job) for job in jobs)
        to_action = [decision for decision in decisions if decision.action == "action"]

        if not dry_run:
            for decision in to_action:
                self._client.mark_job_actioned(
                    decision.job_id,
                    self._actioned_payload(decision.job),
                )

        return RunSummary(
            scanned=len(jobs),
            actioned=len(to_action),
            skipped=len(jobs) - len(to_action),
            dry_run=dry_run,
            decisions=decisions,
        )

    def decide(self, job: Mapping[str, Any]) -> JobDecision:
        job_id = self._job_id(job)
        status = self._normalise(self._field(job, self._config.status_field))
        completed_statuses = {item.lower() for item in self._config.completed_statuses}
        if status not in completed_statuses:
            return JobDecision(job_id, "skip", f"status is {status!r}, not completed", job)

        actioned = self._as_bool(self._field(job, self._config.actioned_field))
        if actioned:
            return JobDecision(job_id, "skip", "job is already actioned", job)

        further_action_required = self._as_bool(self._field(job, self._config.further_action_field))
        if further_action_required:
            return JobDecision(job_id, "skip", "further action is required", job)

        result = self._normalise(self._field(job, self._config.action_result_field))
        action_results = {item.lower() for item in self._config.action_result_values}
        if result not in action_results:
            return JobDecision(
                job_id,
                "skip",
                f"result is {result!r}, not an actionable completion result",
                job,
            )

        return JobDecision(job_id, "action", "completed with no further action required", job)

    def _actioned_payload(self, job: Mapping[str, Any]) -> dict[str, Any]:
        return {
            self._config.actioned_field: self._coerce_actioned_value(),
            "note": self._config.actioned_note,
        }

    def _job_id(self, job: Mapping[str, Any]) -> str:
        for field_name in ("id", "jobId", "job_id", "JobId", "JobID"):
            value = job.get(field_name)
            if value is not None:
                return str(value)
        raise ValueError(f"Job is missing an id field: {job!r}")

    def _field(self, job: Mapping[str, Any], field_name: str) -> Any:
        if field_name in job:
            return job[field_name]
        for key, value in job.items():
            if key.lower() == field_name.lower():
                return value

        custom_fields = job.get("customFields") or job.get("custom_fields")
        if isinstance(custom_fields, Mapping) and field_name in custom_fields:
            return custom_fields[field_name]
        if isinstance(custom_fields, Mapping):
            for key, value in custom_fields.items():
                if str(key).lower() == field_name.lower():
                    return value

        fields = job.get("fields")
        if isinstance(fields, list):
            for item in fields:
                if not isinstance(item, Mapping):
                    continue
                if item.get("name") == field_name or item.get("key") == field_name:
                    return item.get("value")

        return None

    @staticmethod
    def _normalise(value: Any) -> str:
        return str(value or "").strip().lower()

    @staticmethod
    def _as_bool(value: Any) -> bool:
        if isinstance(value, bool):
            return value
        if value is None:
            return False
        if isinstance(value, (int, float)):
            return value != 0
        return str(value).strip().lower() in {"1", "true", "yes", "y", "required"}

    def _coerce_actioned_value(self) -> Any:
        value = self._config.actioned_value.strip()
        lower_value = value.lower()
        if lower_value in {"true", "yes"}:
            return True
        if lower_value in {"false", "no"}:
            return False
        return value
