import datetime as dt
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.bigchange_btr_allocation import load_rules, parse_duration
from scripts.bigchange_btr_daily_run import (
    fetch_incomplete_diary_jobs,
    open_status,
    run_daily,
    site_for_diary_job,
)


class FakeDiaryClient:
    def __init__(self, diary: list[dict]) -> None:
        self.diary = diary

    def resource_diary(self, resource_id: int, start: dt.date, end: dt.date) -> list[dict]:
        return self.diary


class BtrDailyRunTest(unittest.TestCase):
    def test_parse_duration_accepts_numeric_minutes(self) -> None:
        self.assertEqual(parse_duration("90"), 90)
        self.assertEqual(parse_duration(60), 60)

    def test_completed_status_is_not_open_for_stale_reschedule(self) -> None:
        self.assertFalse(open_status({"Status": "Completed", "StatusId": 10}))
        self.assertTrue(open_status({"Status": "Sent", "StatusId": 10}))

    def test_stale_diary_site_prefers_assigned_resource_over_contact(self) -> None:
        rules = load_rules()
        job = {"Contact": "Forbes Place", "Location": "Forbes Place", "Ref": "GRANQ247638"}
        resource = {
            "_name": "UDA_Point _Tech - Eric Wilson",
            "_site": "The Point",
            "_role": "Tech",
        }

        site, method = site_for_diary_job(job, resource, rules)

        self.assertEqual(site, "The Point")
        self.assertIn("resource", method)

    def test_fetch_incomplete_diary_jobs_splits_non_ppm_and_ppm_manual_review(self) -> None:
        rules = load_rules()
        resource = {
            "_id": 428247,
            "_name": "UDC_Chapel_Tech Charlie Lewtas",
            "_site": "Chapel Wharf",
            "_role": "Tech",
        }
        diary = [
            {
                "Ref": "JOB1",
                "JobId": 1,
                "Type": "Building Call Out",
                "Status": "Sent",
                "StatusId": 10,
                "PlannedStart": "2026-07-10 09:00:00",
            },
            {
                "Ref": "PPM1",
                "JobId": 2,
                "Type": "PPM - Daily Internal Inspection BTR",
                "Status": "Sent",
                "StatusId": 10,
                "PlannedStart": "2026-07-10 10:00:00",
            },
        ]

        candidates, manual = fetch_incomplete_diary_jobs(
            FakeDiaryClient(diary),
            [resource],
            rules,
            lookback_days=14,
            today=dt.date(2026, 7, 12),
        )

        self.assertEqual([item["job"]["Ref"] for item in candidates], ["JOB1"])
        self.assertEqual([item["ref"] for item in manual], ["PPM1"])
        self.assertIn("manual review", manual[0]["reason"])

    def test_run_daily_writes_summary_on_setup_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            with patch("scripts.bigchange_btr_daily_run.SUMMARY_DIR", Path(temp_dir)):
                with patch("scripts.bigchange_btr_daily_run.load_rules", side_effect=RuntimeError("missing credentials")):
                    result = run_daily(lookback_days=14, dry_run=True, run_date=dt.date(2026, 7, 12))

            summary_path = Path(result["summary_path"])
            self.assertTrue(summary_path.exists())
            self.assertEqual(result["failed"][0]["ref"], "SETUP")
            self.assertIn("missing credentials", summary_path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
