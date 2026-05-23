import datetime as dt
import unittest

from scripts.bigchange_kpi_report import (
    build_report,
    calculate_sales,
    match_staff_name,
    name_key,
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
            ],
            activities={
                "101": [{"JobClientStatusID": 34, "JobClientStatusDate": "2026-05-02", "JobClientStatusOwner": "Sharon Mannion"}],
                "102": [{"JobClientStatusID": 34, "JobClientStatusDate": "2026-05-03", "JobClientStatusOwner": "Sharon Mannion"}],
                "103": [{"JobClientStatusID": 34, "JobClientStatusDate": "2026-05-04", "JobClientStatusOwner": "Sharon Mannion"}],
            },
        )

        sales = calculate_sales(client, {"Sharon Mannion"}, dt.date(2026, 5, 1), dt.date(2026, 5, 20))

        self.assertEqual(sales["Sharon Mannion"], 170)


class BuildReportFilteringTest(unittest.TestCase):
    def test_uses_requested_kpi_filters_with_bigchange_field_variants(self) -> None:
        today = dt.date.today()
        client = FakeReportClient(today)

        report = build_report(client)

        rows_by_staff = {row["staff_name"]: row for row in report["staff_rows"]}
        self.assertEqual(set(rows_by_staff), {"Sharon Mannion"})
        metrics = rows_by_staff["Sharon Mannion"]["metrics"]
        self.assertEqual(metrics["unallocated_jobs"]["count"], 1)
        self.assertEqual(metrics["historic_jobs"]["count"], 1)
        self.assertEqual(metrics["uninvoiced_jobs"]["count"], 1)
        self.assertEqual(metrics["unactioned_jobs"]["count"], 1)


class FakeBigChangeClient:
    def __init__(self, invoices, activities) -> None:
        self._invoices = invoices
        self._activities = activities

    def invoices_with_items_by_period(self, start, end):
        return self._invoices

    def job_customer_activity(self, job_id):
        return self._activities.get(job_id, [])


class FakeReportClient:
    def __init__(self, today: dt.date) -> None:
        self.today = today

    def categories(self):
        return [
            {"Name": "Sharon Mannion"},
            {"Name": "OOH reactive"},
        ]

    def jobslist(self, params):
        if params.get("Unallocated"):
            return [
                {
                    "JobCategoryName": "Sharon Mannion",
                    "StatusID": 5,
                    "CreatedDate": (self.today - dt.timedelta(days=2)).isoformat(),
                    "ResourceName": "",
                    "PlannedStartDateTime": "",
                },
                {
                    "JobCategoryName": "Sharon Mannion",
                    "CreatedDate": self.today.isoformat(),
                    "ResourceName": "Assigned Engineer",
                    "PlannedStartDateTime": "",
                },
                {
                    "JobCategoryName": "OOH reactive",
                    "CreatedDate": self.today.isoformat(),
                    "ResourceName": "",
                    "PlannedStartDateTime": "",
                },
            ]
        if params.get("Allocated"):
            return [
                {
                    "JobCategoryName": "Sharon Mannion",
                    "StatusID": 16,
                    "EngineerName": "Assigned Engineer",
                    "PlannedStartDate": (self.today - dt.timedelta(days=1)).isoformat(),
                },
                {
                    "JobCategoryName": "Sharon Mannion",
                    "StatusID": 12,
                    "EngineerName": "Assigned Engineer",
                    "PlannedStartDate": (self.today - dt.timedelta(days=1)).isoformat(),
                },
            ]
        if params.get("ClientStatusId") == -34:
            return [
                {
                    "JobCategoryName": "Sharon Mannion",
                    "JobStatusID": 13,
                    "JobClientStatusID": -34,
                    "CompletionDate": (self.today - dt.timedelta(days=3)).isoformat(),
                },
                {
                    "JobCategoryName": "Sharon Mannion",
                    "JobStatusID": 10,
                    "JobClientStatusID": -34,
                    "CompletionDate": (self.today - dt.timedelta(days=3)).isoformat(),
                },
            ]
        if params.get("Unactioned"):
            return [
                {
                    "JobCategoryName": "Sharon Mannion",
                    "JobStatusID": 12,
                    "IsActioned": "No",
                    "CompletionDate": (self.today - dt.timedelta(days=4)).isoformat(),
                },
                {
                    "JobCategoryName": "Sharon Mannion",
                    "JobStatusID": 12,
                    "IsActioned": "Yes",
                    "CompletionDate": (self.today - dt.timedelta(days=4)).isoformat(),
                },
            ]
        return []

    def invoices_with_items_by_period(self, start, end):
        return []

    def job_customer_activity(self, job_id):
        return []


if __name__ == "__main__":
    unittest.main()
