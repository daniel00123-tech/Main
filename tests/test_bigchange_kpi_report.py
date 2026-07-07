import datetime as dt
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.bigchange_kpi_report import (
    build_report,
    calculate_sales,
    code_is_success,
    match_staff_name,
    name_key,
    save_baseline,
    severity_for,
    should_exclude_category,
    validate_report,
)


class CategoryExclusionTest(unittest.TestCase):
    def test_excludes_named_non_staff_categories_with_prefixes(self) -> None:
        for category in (
            "BTR compliance",
            "BTR reactive",
            "John Bennett",
            "Ryan Barrett",
            "RM. John Bennett",
            "RM. Ryan Barrett",
            "Z- subcontractor tracking",
            "OOH reactive",
            "Uncategorised",
        ):
            with self.subTest(category=category):
                self.assertTrue(should_exclude_category(category))

    def test_report_validation_blocks_excluded_rows_before_email(self) -> None:
        report = {"staff_rows": [{"staff_name": "RM. Ryan Barrett"}]}

        with self.assertRaisesRegex(RuntimeError, "excluded non-staff"):
            validate_report(report)


class BigChangeApiTest(unittest.TestCase):
    def test_accepts_legacy_success_code_shapes(self) -> None:
        self.assertTrue(code_is_success({"Code": 0}))
        self.assertTrue(code_is_success({"Code": "0"}))
        self.assertFalse(code_is_success({"Code": 1}))


class SalesAttributionTest(unittest.TestCase):
    def test_matches_invoice_creators_to_prefixed_job_categories(self) -> None:
        staff_by_key = {
            name_key(name): name
            for name in ("A- Jodie", "B- Jenna Hyde", "C- Grace Elver")
            if name_key(name)
        }

        self.assertEqual(match_staff_name("Jodie Rock", staff_by_key), "A- Jodie")
        self.assertEqual(match_staff_name("Jenna Hyde", staff_by_key), "B- Jenna Hyde")
        self.assertEqual(match_staff_name("Grace Elver", staff_by_key), "C- Grace Elver")

    def test_matches_known_aliases_and_last_name_initials(self) -> None:
        staff_by_key = {name_key(name): name for name in ("Amy Bradley", "Daniel Dwyer") if name_key(name)}

        self.assertEqual(match_staff_name("Amy B", staff_by_key), "Amy Bradley")
        self.assertEqual(match_staff_name("Dan Dwyer", staff_by_key), "Daniel Dwyer")

    def test_uses_runtime_aliases_for_staff_name_mismatches(self) -> None:
        staff_by_key = {name_key("Daniel Dwyer"): "Daniel Dwyer"}

        with patch.dict(os.environ, {"STAFF_NAME_ALIASES": "DD=Daniel Dwyer"}):
            self.assertEqual(match_staff_name("DD", staff_by_key), "Daniel Dwyer")

    def test_calculates_invoice_net_from_common_line_shapes(self) -> None:
        client = FakeBigChangeClient(
            invoices=[
                {
                    "OrderType": "Invoice",
                    "JobId": "101",
                    "Lines": [
                        {"NetPrice": "120.00", "VatAmount": "20.00"},
                        {"NetPrice": "60.00", "VatAmount": "10.00"},
                    ],
                },
                {
                    "OrderType": "Invoice",
                    "LinkedJobID": "102",
                    "FinancialLines": {"FinancialLine": [{"NetPrice": "24.00", "VatAmount": "4.00"}]},
                },
                {
                    "OrderType": "Invoice",
                    "JobId": "103",
                    "Cancelled": "true",
                    "Lines": [{"NetPrice": "999.00", "VatAmount": "0.00"}],
                },
                {
                    "DocumentType": "Sales Invoice",
                    "JobID": "104",
                    "Lines": [{"NetPrice": "12.00", "VatAmount": "2.00"}],
                },
                {
                    "OrderType": "Invoice",
                    "JobId": "105",
                    "Cancelled": "false",
                    "Deleted": "No",
                    "Rejected": "0",
                    "Lines": [{"NetPrice": "6.00", "VatAmount": "1.00"}],
                },
            ],
            activities={
                "101": [{"JobClientStatusID": 34, "JobClientStatusDate": "2026-05-02", "JobClientStatusOwner": "Sharon Mannion"}],
                "102": [{"JobClientStatusID": 34, "JobClientStatusDate": "2026-05-03", "JobClientStatusOwner": "Sharon Mannion"}],
                "103": [{"JobClientStatusID": 34, "JobClientStatusDate": "2026-05-04", "JobClientStatusOwner": "Sharon Mannion"}],
                "104": [{"JobClientStatusName": "InvoiceCreated", "ActivityDate": "2026-05-05", "ClientStatusOwner": "Amy B"}],
                "105": [{"JobClientStatusID": 34, "JobClientStatusDate": "2026-05-06", "JobClientStatusOwner": "Sharon Mannion"}],
            },
        )

        sales = calculate_sales(client, {"Sharon Mannion", "Amy Bradley"}, dt.date(2026, 5, 1), dt.date(2026, 5, 20))

        self.assertEqual(sales["Sharon Mannion"], 175)
        self.assertEqual(sales["Amy Bradley"], 10)


class SeverityAndBaselineTest(unittest.TestCase):
    def test_colours_counted_items_by_oldest_age(self) -> None:
        self.assertEqual(severity_for(0, 99), "green")
        self.assertEqual(severity_for(2, 9), "green")
        self.assertEqual(severity_for(2, 10), "amber")
        self.assertEqual(severity_for(2, 30), "amber")
        self.assertEqual(severity_for(2, 31), "red")

    def test_saves_bigchange_only_baseline_fields(self) -> None:
        report = {
            "run_timestamp": "2026-05-25T07:00:00+00:00",
            "report_date": "2026-05-25",
            "job_lookback_start": "2025-05-25",
            "staff_rows": [
                {
                    "staff_name": "Amy Bradley",
                    "metrics": {
                        "unallocated_jobs": {"count": 0, "status": "green", "oldest_age_days": 0},
                        "historic_jobs": {"count": 1, "status": "amber", "oldest_age_days": 12},
                        "uninvoiced_jobs": {"count": 0, "status": "green", "oldest_age_days": 0},
                        "unactioned_jobs": {"count": 0, "status": "green", "oldest_age_days": 0},
                    },
                    "current_month_sales": 123.45,
                }
            ],
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "kpi-baseline.json"
            save_baseline(report, path)

            baseline = json.loads(path.read_text(encoding="utf-8"))

        self.assertEqual(
            set(baseline["staff"][0]["counts"]),
            {"unallocated_jobs", "historic_jobs", "uninvoiced_jobs", "unactioned_jobs"},
        )
        self.assertNotIn("overall_score", baseline["staff"][0])


class RankingTest(unittest.TestCase):
    def test_sorts_staff_by_red_then_amber_then_workload(self) -> None:
        client = FakeReportBigChangeClient()

        with patch("scripts.bigchange_kpi_report.dt.date", FixedDate):
            report = build_report(client)

        self.assertEqual(
            [row["staff_name"] for row in report["staff_rows"]],
            ["All Green", "Amber Light", "Amber Heavy", "Red Owner"],
        )


class FakeBigChangeClient:
    def __init__(self, invoices, activities) -> None:
        self._invoices = invoices
        self._activities = activities

    def invoices_with_items_by_period(self, start, end):
        return self._invoices

    def job_customer_activity(self, job_id):
        return self._activities.get(job_id, [])


class FixedDate(dt.date):
    @classmethod
    def today(cls):
        return cls(2026, 5, 25)


class FakeReportBigChangeClient:
    def categories(self):
        return [
            {"Name": "All Green"},
            {"Name": "Amber Light"},
            {"Name": "Amber Heavy"},
            {"Name": "Red Owner"},
            {"Name": "Nirvana PPM"},
        ]

    def jobslist(self, params, page_size=500):
        status_id = str(params.get("StatusId", ""))
        if params.get("Unallocated") == 1:
            return [
                {"Category": "All Green", "StatusId": 1, "Created": "2026-05-22"},
                {"Category": "Amber Light", "StatusId": 1, "Created": "2026-05-10"},
                {"Category": "Amber Heavy", "StatusId": 1, "Created": "2026-05-10"},
                {"Category": "Amber Heavy", "StatusId": 1, "Created": "2026-05-12"},
                {"Category": "Red Owner", "StatusId": 1, "Created": "2026-04-01"},
                {"Category": "Nirvana PPM", "StatusId": 1, "Created": "2026-04-01"},
            ]
        if params.get("Allocated") == 1:
            return []
        if status_id == "12|13" and params.get("ClientStatusId") == -34:
            return []
        if status_id == "12|13" and params.get("Unactioned") == 1:
            return []
        return []

    def invoices_with_items_by_period(self, start, end):
        return []

    def job_customer_activity(self, job_id):
        return []


if __name__ == "__main__":
    unittest.main()
