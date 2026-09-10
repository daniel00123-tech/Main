import datetime as dt
import decimal
import unittest

from scripts.staff_commission import (
    attach_job_commissions,
    calculate_job_commission,
    sum_job_commissions,
)
from scripts.staff_profit_report import (
    build_html,
    build_staff_rows,
    commission_style,
    daily_totals,
    iter_display_rows,
)


D = decimal.Decimal


def _job(date, reference, sale, profit, cost=None, key=None):
    sale = D(str(sale))
    profit = D(str(profit))
    cost = D("0") if cost is None else D(str(cost))
    if cost == 0 and sale != profit:
        cost = sale - profit
    return {
        "key": key or reference,
        "date": date,
        "reference": reference,
        "sale": sale,
        "cost": cost,
        "profit": profit,
        "margin": (profit / sale * D("100")).quantize(D("0.1")) if sale else None,
    }


class DisplayRowTest(unittest.TestCase):
    def test_day_subtotal_sums_job_commission_and_does_not_recalculate(self) -> None:
        jobs = attach_job_commissions(
            [
                _job(dt.date(2026, 8, 3), "GR/1", "1500", "525"),
                _job(dt.date(2026, 8, 3), "GR/2", "1500", "525"),
                _job(dt.date(2026, 8, 4), "GR/3", "3000", "1050"),
            ]
        )
        display = iter_display_rows(jobs)
        kinds = [row["kind"] for row in display]
        self.assertEqual(kinds, ["job", "job", "day_total", "job", "day_total"])
        day1 = display[2]
        self.assertEqual(day1["commission"], D("52.50"))
        self.assertNotEqual(
            day1["commission"],
            calculate_job_commission(D("3000"), D("1050")).commission,
        )
        month_total = sum_job_commissions(jobs)
        self.assertEqual(month_total, D("131.25"))
        self.assertNotEqual(month_total, calculate_job_commission(D("6000"), D("2100")).commission)

    def test_daily_totals_use_summed_commission(self) -> None:
        jobs = attach_job_commissions(
            [
                _job(dt.date(2026, 8, 3), "GR/1", "1500", "525"),
                _job(dt.date(2026, 8, 3), "GR/2", "1500", "525"),
            ]
        )
        days = daily_totals(jobs)
        self.assertEqual(len(days), 1)
        self.assertEqual(days[0]["commission"], D("52.50"))


class HtmlReportTest(unittest.TestCase):
    def test_job_table_has_commission_columns_and_colours(self) -> None:
        jobs = attach_job_commissions(
            [
                _job(dt.date(2026, 8, 3), "GR/1", "1500", "525"),
                _job(dt.date(2026, 8, 4), "GR/2", "3000", "450"),
            ]
        )
        body = build_html(staff_name="Sharon", month_label="August 2026", job_rows=jobs, anomaly_rows=[])
        self.assertIn("Invoice date", body)
        self.assertIn("Group / job", body)
        self.assertIn("Commission", body)
        self.assertIn("Running profit", body)
        self.assertIn("Running commission", body)
        self.assertIn("£26.25", body)
        self.assertIn("-£150.00", body)
        self.assertIn("NOT YET QUALIFIED", body)
        self.assertIn("Your current commission is", body)
        self.assertIn(commission_style(D("26.25")), body)
        self.assertIn(commission_style(D("-150.00")), body)
        self.assertNotIn("calculate_job_commission", body)
        # Anomalies are excluded from commission.
        self.assertIn("Not included in the totals or commission above", body)

    def test_qualified_status_is_green_and_shows_earned(self) -> None:
        jobs = attach_job_commissions(
            [_job(dt.date(2026, 8, 1), "GR/BIG", "40000", "12000")]
        )
        body = build_html(staff_name="Sharon", month_label="August 2026", job_rows=jobs, anomaly_rows=[])
        self.assertIn("COMMISSION QUALIFIED", body)
        self.assertIn("Commission Earned:", body)
        self.assertIn("#d4edda", body)

    def test_duplicate_group_keys_are_not_created_by_row_builder(self) -> None:
        jobs = [
            {
                "id": 1,
                "categoryId": 132264,
                "jobGroupId": 10,
                "status": "completedOk",
                "reference": "EL1",
                "actualEndAt": "2026-08-01T12:00:00Z",
            },
            {
                "id": 2,
                "categoryId": 132264,
                "jobGroupId": 10,
                "status": "completedOk",
                "reference": "EL2",
                "actualEndAt": "2026-08-02T12:00:00Z",
            },
        ]
        docs = [
            {
                "OrderType": "Invoice",
                "JobId": "1",
                "DocumentDate": "2026-08-03",
                "lines": [{"LineQuantity": 1, "UnitPrice": "1500", "CostPrice": 0}],
            },
            {
                "OrderType": "Invoice",
                "JobId": "2",
                "DocumentDate": "2026-08-10",
                "lines": [{"LineQuantity": 1, "UnitPrice": "1500", "CostPrice": 0}],
            },
            {
                "OrderType": "PurchaseOrder",
                "JobId": "1",
                "DocumentDate": "2026-08-03",
                "lines": [{"LineQuantity": 1, "UnitPrice": "0", "CostPrice": "1950"}],
            },
        ]
        main_rows, anomaly_rows = build_staff_rows(
            jobs=jobs,
            docs=docs,
            group_refs={10: {"reference": "GR/10"}},
            category_id=132264,
            month_start=dt.date(2026, 8, 1),
            month_end=dt.date(2026, 8, 31),
        )
        self.assertEqual(anomaly_rows, [])
        self.assertEqual(len(main_rows), 1)
        self.assertEqual(main_rows[0]["reference"], "GR/10")
        self.assertEqual(main_rows[0]["sale"], D("3000.00"))
        self.assertEqual(main_rows[0]["cost"], D("1950.00"))
        self.assertEqual(main_rows[0]["profit"], D("1050.00"))
        attached = attach_job_commissions(main_rows)
        self.assertEqual(attached[0]["commission"], D("78.75"))


if __name__ == "__main__":
    unittest.main()
