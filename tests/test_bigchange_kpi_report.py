import unittest

from scripts.bigchange_kpi_report import render_html, should_exclude_category, validate_report


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


class DashboardRenderTest(unittest.TestCase):
    def test_sales_column_is_after_job_kpis(self) -> None:
        report = {
            "run_timestamp": "2026-05-19T07:00:00+00:00",
            "report_date": "2026-05-19",
            "job_lookback_start": "2025-05-19",
            "month_name": "May",
            "total_red_kpis": 0,
            "total_amber_kpis": 0,
            "staff_rows": [
                {
                    "staff_name": "Jane Doe",
                    "current_month_sales_display": "GBP 0.00",
                    "total_open_workload": 0,
                    "metrics": {
                        key: {"count": 0, "oldest_age_days": 0, "status": "green"}
                        for key in (
                            "unallocated_jobs",
                            "historic_jobs",
                            "uninvoiced_jobs",
                            "unactioned_jobs",
                        )
                    },
                }
            ],
        }

        html = render_html(report)

        self.assertLess(html.index("<th>Unallocated Jobs</th>"), html.index("<th>May sales</th>"))
        self.assertLess(html.index("<th>Unactioned Jobs</th>"), html.index("<th>May sales</th>"))


if __name__ == "__main__":
    unittest.main()
