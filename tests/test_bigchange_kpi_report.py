import datetime as dt
import decimal
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.bigchange_kpi_report import (
    KPI_ORDER,
    build_staff_rows,
    calculate_sales,
    code_is_success,
    match_staff_name,
    name_key,
    save_baseline,
    should_exclude_category,
    validate_report,
)


class CategoryExclusionTest(unittest.TestCase):
    def test_excludes_non_staff_categories(self) -> None:
        for category in (
            "Nirvana PPM",
            "OOH reactive",
            "Out of Hours - North",
            "Uncategorised",
            "BTR compliance",
            "BTR reactive",
            "RM. John Bennett",
            "RM. Ryan Barrett",
            "Z- subcontractor tracking",
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
        self.assertTrue(code_is_success({}))
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

    def test_calculates_invoice_net_from_latest_invoice_created_activity(self) -> None:
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
                    "OrderType": "Credit Note",
                    "JobId": "105",
                    "Lines": [{"NetPrice": "999.00", "VatAmount": "0.00"}],
                },
            ],
            activities={
                "101": [
                    {
                        "JobClientStatusID": 34,
                        "JobClientStatusDate": "2026-05-01",
                        "JobClientStatusOwner": "Older User",
                    },
                    {
                        "JobClientStatusID": 34,
                        "JobClientStatusDate": "2026-05-02",
                        "JobClientStatusOwner": "Sharon Mannion",
                    },
                ],
                "102": [{"JobClientStatusID": 34, "JobClientStatusDate": "2026-05-03", "JobClientStatusOwner": "Sharon Mannion"}],
                "103": [{"JobClientStatusID": 34, "JobClientStatusDate": "2026-05-04", "JobClientStatusOwner": "Sharon Mannion"}],
                "104": [{"JobClientStatusName": "InvoiceCreated", "ActivityDate": "2026-05-05", "ClientStatusOwner": "Amy B"}],
                "105": [{"JobClientStatusID": 34, "JobClientStatusDate": "2026-05-06", "JobClientStatusOwner": "Sharon Mannion"}],
            },
        )

        sales = calculate_sales(client, {"Sharon Mannion", "Amy Bradley"}, dt.date(2026, 5, 1), dt.date(2026, 5, 20))

        self.assertEqual(sales["Sharon Mannion"], decimal.Decimal("170.00"))
        self.assertEqual(sales["Amy Bradley"], decimal.Decimal("10.00"))


class StaffRowsAndBaselineTest(unittest.TestCase):
    def test_sorts_staff_best_to_worst_by_red_amber_then_workload(self) -> None:
        today = dt.date(2026, 5, 25)
        grouped = {
            "All Green": {
                "unallocated_jobs": [dt.datetime(2026, 5, 24)],
                "historic_jobs": [],
                "uninvoiced_jobs": [],
                "unactioned_jobs": [],
            },
            "Amber Low": {
                "unallocated_jobs": [dt.datetime(2026, 5, 10)],
                "historic_jobs": [],
                "uninvoiced_jobs": [],
                "unactioned_jobs": [],
            },
            "Amber High": {
                "unallocated_jobs": [dt.datetime(2026, 5, 10), dt.datetime(2026, 5, 12)],
                "historic_jobs": [],
                "uninvoiced_jobs": [],
                "unactioned_jobs": [],
            },
            "Red Staff": {
                "unallocated_jobs": [dt.datetime(2026, 4, 1)],
                "historic_jobs": [],
                "uninvoiced_jobs": [],
                "unactioned_jobs": [],
            },
        }

        rows = build_staff_rows(set(grouped), grouped, {}, today)

        self.assertEqual([row["staff_name"] for row in rows], ["All Green", "Amber Low", "Amber High", "Red Staff"])
        self.assertEqual(rows[0]["metrics"]["unallocated_jobs"]["status"], "green")
        self.assertEqual(rows[1]["metrics"]["unallocated_jobs"]["status"], "amber")
        self.assertEqual(rows[3]["metrics"]["unallocated_jobs"]["status"], "red")

    def test_saves_baseline_with_requested_bigchange_fields_only(self) -> None:
        report = {
            "run_timestamp": "2026-05-25T07:00:00+00:00",
            "report_date": "2026-05-25",
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

        self.assertEqual(baseline["run_timestamp"], "2026-05-25T07:00:00+00:00")
        self.assertEqual(baseline["staff"][0]["staff_name"], "Amy Bradley")
        self.assertEqual(baseline["staff"][0]["current_month_sales"], 123.45)
        self.assertEqual(set(baseline["staff"][0]["counts"]), {metric_key for metric_key, _ in KPI_ORDER})
        self.assertNotIn("open_freshdesk_tickets", baseline["staff"][0]["counts"])
        self.assertNotIn("overall_score", baseline["staff"][0])


class FakeBigChangeClient:
    def __init__(self, invoices, activities) -> None:
        self._invoices = invoices
        self._activities = activities

    def invoices_with_items_by_period(self, start, end):
        return self._invoices

    def job_customer_activity(self, job_id):
        return self._activities.get(job_id, [])


if __name__ == "__main__":
    unittest.main()
