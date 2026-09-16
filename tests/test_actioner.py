from __future__ import annotations

from datetime import date
import unittest

from bigchange_actioner.actioner import is_actionable_job, run_actioner
from bigchange_actioner.config import BigChangeConfig


def make_config(**overrides: object) -> BigChangeConfig:
    values = {
        "auth_mode": "api_key",
        "base_url": "https://webservice.bigchange.com/v01/services.ashx",
        "api_key": "api-key",
        "username": "user",
        "password": "pass",
        "lookback_days": 14,
        "page_size": 2,
        "completed_statuses": ("Completed", "Completed with issues"),
        "status_field": "Status",
        "actioned_field": "Actioned",
        "action_result_field": "StatusComment",
        "action_result_values": ("Complete", "Completed"),
        "action_note": "Marked actioned by automation",
        "actioned_request_value": "1",
    }
    values.update(overrides)
    return BigChangeConfig(**values)


class FakeClient:
    def __init__(self, pages: list[list[dict[str, object]]]) -> None:
        self.pages = pages
        self.list_calls: list[dict[str, object]] = []
        self.actioned_job_ids: list[object] = []

    def list_jobs(self, **kwargs: object) -> list[dict[str, object]]:
        self.list_calls.append(kwargs)
        page = int(kwargs["page"])
        return self.pages[page] if page < len(self.pages) else []

    def save_back_office_note(self, **kwargs: object) -> dict[str, object]:
        self.actioned_job_ids.append(kwargs["job_id"])
        return {"Code": 0, "Result": "OK"}


class ActionerTests(unittest.TestCase):
    def test_only_safe_completed_jobs_are_actionable(self) -> None:
        config = make_config()

        self.assertTrue(
            is_actionable_job(
                {"Status": "Completed", "Actioned": "No", "StatusComment": "Complete"},
                config,
            )
        )
        self.assertTrue(
            is_actionable_job(
                {
                    "Status": "Completed with issues",
                    "Actioned": "false",
                    "StatusComment": "Completed",
                },
                config,
            )
        )
        self.assertFalse(
            is_actionable_job(
                {
                    "Status": "Completed",
                    "Actioned": "No",
                    "StatusComment": "Completed Quote Required",
                },
                config,
            )
        )
        self.assertFalse(
            is_actionable_job(
                {"Status": "Completed", "Actioned": "Yes", "StatusComment": "Complete"},
                config,
            )
        )

    def test_run_actioner_paginates_and_actions_only_candidates(self) -> None:
        config = make_config()
        client = FakeClient(
            [
                [
                    {
                        "JobId": 186829736,
                        "Status": "Completed",
                        "Actioned": "No",
                        "StatusComment": "Complete",
                    },
                    {
                        "JobId": 2,
                        "Status": "Completed",
                        "Actioned": "No",
                        "StatusComment": "Quote Required",
                    },
                ],
                [
                    {
                        "JobId": 3,
                        "Status": "Completed with issues",
                        "Actioned": "0",
                        "StatusComment": "Completed",
                    }
                ],
            ]
        )

        summary = run_actioner(
            client=client,
            config=config,
            execute=True,
            today=date(2026, 5, 16),
        )

        self.assertEqual(summary.to_dict(), {
            "jobs_scanned": 3,
            "jobs_actioned": 2,
            "failures": 0,
            "remaining_actionable_jobs": 0,
        })
        self.assertEqual(client.actioned_job_ids, [186829736, 3])
        self.assertEqual(client.list_calls[0]["start"], "2026-05-02")
        self.assertEqual(client.list_calls[0]["end"], "2026-05-16")
        self.assertEqual(client.list_calls[0]["page"], 0)
        self.assertEqual(client.list_calls[1]["page"], 1)

    def test_dry_run_reports_remaining_actionable_jobs_without_actioning(self) -> None:
        config = make_config()
        client = FakeClient(
            [
                [
                    {
                        "JobId": 1,
                        "Status": "Completed",
                        "Actioned": "",
                        "StatusComment": "Complete",
                    }
                ]
            ]
        )

        summary = run_actioner(
            client=client,
            config=config,
            execute=False,
            today=date(2026, 5, 16),
        )

        self.assertEqual(summary.jobs_scanned, 1)
        self.assertEqual(summary.jobs_actioned, 0)
        self.assertEqual(summary.remaining_actionable_jobs, 1)
        self.assertEqual(client.actioned_job_ids, [])


if __name__ == "__main__":
    unittest.main()
