import unittest

from scripts.bigchange_kpi_report import KPI_ORDER, render_html, should_exclude_category, validate_report


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


class DashboardRenderingTest(unittest.TestCase):
    def test_sales_column_is_rendered_after_operational_kpis(self) -> None:
        report = {
            "run_timestamp": "2026-05-20T07:00:00+00:00",
            "report_date": "2026-05-20",
            "job_lookback_start": "2025-05-20",
            "month_name": "May",
            "total_red_kpis": 0,
            "total_amber_kpis": 0,
            "staff_rows": [
                {
                    "staff_name": "Sharon Mannion",
                    "metrics": {
                        metric_key: {
                            "count": 0,
                            "oldest_age_days": 0,
                            "status": "green",
                        }
                        for metric_key, _label in KPI_ORDER
                    },
                    "current_month_sales": 0.0,
                    "current_month_sales_display": "GBP 0.00",
                    "red_kpis": 0,
                    "amber_kpis": 0,
                    "total_open_workload": 0,
                }
            ],
        }

        html = render_html(report)

        expected_headers = [
            "<th>Unallocated Jobs</th>",
            "<th>Historic Jobs</th>",
            "<th>Uninvoiced Jobs</th>",
            "<th>Unactioned Jobs</th>",
            "<th>May sales</th>",
        ]
        indexes = [html.index(header) for header in expected_headers]
        self.assertEqual(indexes, sorted(indexes))


if __name__ == "__main__":
    unittest.main()
