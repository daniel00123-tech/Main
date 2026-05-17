import datetime as dt
import unittest

from scripts.weekly_door_to_door_timesheets import build_day_row


def job(job_id, ref, planned_start, planned_end, real_start=None):
    row = {
        "JobId": job_id,
        "Ref": ref,
        "PlannedStart": planned_start,
        "PlannedEnd": planned_end,
        "Postcode": "TN13 1NY",
    }
    if real_start:
        row["RealStart"] = real_start
    return row


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
        self.assertEqual(row["Finish"], "")
        self.assertEqual(row["Original Start"], "")
        self.assertEqual(row["Start Source"], "No actual start/travel found")
        self.assertEqual(row["Finish Source"], "No actual finish found")
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

    def test_standalone_travel_start_is_ignored_without_actual_job_start(self):
        row = build_day_row(
            None,
            {"id": 1, "CleanName": "Saud Amjad"},
            self.day,
            [job(10, "AF29959", "2026-05-15 08:00:00", "2026-05-15 16:00:00")],
            [],
            {"address": "80 Stanhope Road, Greenford, UB6 9EA, United Kingdom"},
            {10: [status(8, "2026-05-15 06:50:56")]},
        )

        self.assertEqual(row["Start"], "")
        self.assertEqual(row["Original Start"], "")
        self.assertEqual(row["Finish"], "")
        self.assertEqual(row["Start Source"], "No actual start/travel found")
        self.assertEqual(row["Finish Source"], "No actual finish found")

    def test_travel_start_is_used_when_anchored_to_actual_job_start(self):
        row = build_day_row(
            None,
            self.resource,
            self.day,
            [job(10, "AF29959", "2026-05-15 08:00:00", "2026-05-15 16:00:00")],
            [],
            self.home,
            {10: [status(8, "2026-05-15 06:50:56"), status(10, "2026-05-15 08:15:00")]},
        )

        self.assertEqual(row["Start"], "06:50")
        self.assertEqual(row["Original Start"], "06:50")
        self.assertEqual(row["Start Source"], "Start travel pressed")

    def test_late_travel_start_is_ignored_without_actual_job_start(self):
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

    def test_missing_first_job_start_moves_to_next_real_start(self):
        row = build_day_row(
            None,
            self.resource,
            self.day,
            [
                job(10, "INT30002", "2026-05-15 08:00:00", "2026-05-15 09:00:00"),
                job(
                    11,
                    "INT30009",
                    "2026-05-15 12:03:00",
                    "2026-05-15 12:04:00",
                    real_start="2026-05-15 12:03:30",
                ),
            ],
            [],
            self.home,
            {10: [], 11: []},
        )

        self.assertEqual(row["Start"], "12:03")
        self.assertEqual(row["Start Source"], "First job started")


if __name__ == "__main__":
    unittest.main()
