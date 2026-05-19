import unittest

from scripts.bigchange_kpi_report import (
    KPI_ORDER,
    render_html,
    should_exclude_category,
    status_payload,
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
        ):
            with self.subTest(category=category):
                self.assertTrue(should_exclude_category(category))

    def test_report_validation_blocks_excluded_rows_before_email(self) -> None:
        report = {"staff_rows": [{"staff_name": "RM. Ryan Barrett"}]}

        with self.assertRaisesRegex(RuntimeError, "excluded non-staff"):
            validate_report(report)


class OutputContractTest(unittest.TestCase):
    def test_status_payload_contains_only_requested_fields(self) -> None:
        payload = status_payload(
            {"staff_rows": [{}, {}], "total_red_kpis": 3, "total_amber_kpis": 4},
            "failed",
        )

        self.assertEqual(
            payload,
            {
                "staff_rows_included": 2,
                "total_red_kpis": 3,
                "total_amber_kpis": 4,
                "email": "failed",
            },
        )

    def test_sales_column_renders_after_kpi_columns(self) -> None:
        report = {
            "run_timestamp": "2026-05-19T07:00:00+00:00",
            "report_date": "2026-05-19",
            "job_lookback_start": "2025-05-19",
            "month_name": "May",
            "staff_rows": [
                {
                    "staff_name": "Sharon Mannion",
                    "metrics": {
                        metric_key: {"count": 0, "oldest_age_days": 0, "status": "green"}
                        for metric_key, _label in KPI_ORDER
                    },
                    "current_month_sales_display": "GBP 1,234.56",
                    "red_kpis": 0,
                    "amber_kpis": 0,
                    "total_open_workload": 0,
                }
            ],
            "total_red_kpis": 0,
            "total_amber_kpis": 0,
        }

        html = render_html(report)

        self.assertLess(html.index("<th>Unactioned Jobs</th>"), html.index("<th>May sales</th>"))
        self.assertLess(html.index("0 days old"), html.index("GBP 1,234.56"))


if __name__ == "__main__":
    unittest.main()
