import datetime as dt
import decimal
import unittest

from scripts.staff_labor import (
    HOURLY_RATE,
    allocate_engineer_day,
    is_subcontractor_job,
    labor_cost_for_jobs,
    labor_for_bucket,
    money,
)


D = decimal.Decimal


def _member(
    job_id: int,
    *,
    minutes: int = 120,
    resource_id: int = 1,
    group: str = "Employees",
    ppm: bool = False,
    start: str = "2026-08-05T09:00:00+01:00",
) -> dict:
    job_type = "PPM service" if ppm else "Reactive"
    return {
        "id": job_id,
        "plannedDurationMinutes": minutes,
        "plannedStartAt": start,
        "resourceId": resource_id,
        "resourceGroupName": group,
        "typeName": job_type,
        "status": "completedOk",
    }


class SubcontractorDetectionTest(unittest.TestCase):
    def test_subcontractor_resource_group_is_excluded_from_payroll(self) -> None:
        job = _member(1, group="Subcontractors")
        self.assertTrue(is_subcontractor_job(job))
        self.assertEqual(labor_for_bucket([job]), D("0.00"))

    def test_employee_group_is_included(self) -> None:
        job = _member(1, minutes=60)
        self.assertFalse(is_subcontractor_job(job))
        self.assertGreater(labor_for_bucket([job]), D("0"))


class DurationRulesTest(unittest.TestCase):
    def test_one_hour_job_gets_single_job_travel_for_full_day(self) -> None:
        job = _member(1, minutes=60)
        total, by_job = labor_cost_for_jobs([job])
        self.assertEqual(by_job[1], money(D("75.00")))  # 2h × £37.50
        self.assertEqual(total, money(D("75.00")))

    def test_sub_one_hour_non_ppm_uses_ninety_minute_minimum(self) -> None:
        jobs = [
            _member(1, minutes=60, start="2026-08-05T09:00:00+01:00"),
            _member(2, minutes=60, start="2026-08-05T13:00:00+01:00"),
        ]
        total, _ = labor_cost_for_jobs(jobs)
        # 1.5h + 0.5 travel each = 4h × rate
        self.assertEqual(total, money(D("150.00")))

    def test_ppm_skips_ninety_minute_floor(self) -> None:
        jobs = [
            _member(1, minutes=60, ppm=True, start="2026-08-05T09:00:00+01:00"),
            _member(2, minutes=60, ppm=True, start="2026-08-05T13:00:00+01:00"),
        ]
        total, _ = labor_cost_for_jobs(jobs)
        # 1h + 0.5 travel each = 3h × rate
        self.assertEqual(total, money(D("112.50")))

    def test_three_two_hour_jobs_scale_to_eight_hour_cap(self) -> None:
        jobs = [
            _member(1, minutes=120, start="2026-08-05T08:00:00+01:00"),
            _member(2, minutes=120, start="2026-08-05T11:00:00+01:00"),
            _member(3, minutes=120, start="2026-08-05T14:00:00+01:00"),
        ]
        total, by_job = labor_cost_for_jobs(jobs)
        self.assertEqual(sum(by_job.values(), D("0")), money(HOURLY_RATE * D("7.5")))
        self.assertEqual(total, money(HOURLY_RATE * D("7.5")))

    def test_morning_only_two_jobs_use_half_day_cap(self) -> None:
        jobs = [
            _member(1, minutes=120, start="2026-08-05T08:00:00+01:00"),
            _member(2, minutes=120, start="2026-08-05T10:00:00+01:00"),
        ]
        total, _ = labor_cost_for_jobs(jobs)
        self.assertEqual(total, money(HOURLY_RATE * D("4")))

    def test_after_five_pm_job_adds_outside_day_cap(self) -> None:
        jobs = [
            _member(1, minutes=480, start="2026-08-05T08:00:00+01:00"),
            _member(2, minutes=120, start="2026-08-05T18:00:00+01:00"),
        ]
        total, _ = labor_cost_for_jobs(jobs)
        # 8h capped day job + 2h work + 1h travel on evening job
        self.assertEqual(total, money(HOURLY_RATE * D("11")))


class AllocateEngineerDayTest(unittest.TestCase):
    def test_skip_travel_when_planned_work_fills_eight_hours(self) -> None:
        from scripts.staff_labor import LaborJob

        jobs = [
            LaborJob(1, "e1", dt.date(2026, 8, 5), D("4"), D("4"), False, False, dt.time(9)),
            LaborJob(2, "e1", dt.date(2026, 8, 5), D("4"), D("4"), False, False, dt.time(13)),
        ]
        paid = allocate_engineer_day(jobs)
        self.assertEqual(paid[1] + paid[2], D("8"))


if __name__ == "__main__":
    unittest.main()
