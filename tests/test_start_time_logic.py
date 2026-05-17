import datetime as dt
import unittest

from scripts.weekly_door_to_door_timesheets import build_day_row


def job(job_id, ref, planned_start, planned_end):
    return {
        "JobId": job_id,
        "Ref": ref,
        "PlannedStart": planned_start,
        "PlannedEnd": planned_end,
        "Postcode": "TN13 1NY",
    }


def status(status_id, when):
    return {
        "JobStatusID": status_id,
        "JobStatusDate": when,
    }


class StartTimeLogicTest(unittest.TestCase):
    def setUp(self):
        self.resource = {"id": 1, "CleanName": "Mohammed Timami"}
        self.home = {"address": "No CRM address found; using resource postcode suffix/outcode M8"}
        self.day = dt.date(2026, 5, 15)

    def test_start_does_not_fall_back_to_planned_time(self):
        row = build_day_row(
            None,
            self.resource,
            self.day,
            [job(10, "INT30002", "2026-05-15 08:00:00", "2026-05-15 12:00:00")],
            [],
            self.home,
            {10: []},
        )

        self.assertEqual(row["Start"], "")
        self.assertEqual(row["Original Start"], "")
        self.assertEqual(row["Start Source"], "No actual start/travel found")
        self.assertEqual(row["Adjusted Hrs"], 0.0)
        self.assertEqual(
            row["Original Time / Deduction Reason"],
            "No valid travel gap: no actual start/travel time found",
        )

    def test_start_uses_first_actual_started_status_across_day_jobs(self):
        row = build_day_row(
            None,
            self.resource,
            self.day,
            [
                job(10, "INT30002", "2026-05-15 08:00:00", "2026-05-15 09:00:00"),
                job(11, "INT30009", "2026-05-15 12:03:00", "2026-05-15 12:04:00"),
            ],
            [],
            self.home,
            {
                10: [],
                11: [status(10, "2026-05-15 12:03:30")],
            },
        )

        self.assertEqual(row["Start"], "12:03")
        self.assertEqual(row["Original Start"], "12:03")
        self.assertEqual(row["Start Source"], "First job started")

    def test_travel_start_is_ignored_without_actual_job_start(self):
        row = build_day_row(
            None,
            self.resource,
            self.day,
            [job(10, "INT30002", "2026-05-15 08:00:00", "2026-05-15 12:00:00")],
            [],
            self.home,
            {10: [status(8, "2026-05-15 17:50:16")]},
        )

        self.assertEqual(row["Start"], "")
        self.assertEqual(row["Start Source"], "No actual start/travel found")


if __name__ == "__main__":
    unittest.main()
