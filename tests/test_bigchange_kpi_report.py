import tempfile
import unittest
from email import message_from_string
from pathlib import Path
from unittest.mock import patch

from scripts.bigchange_kpi_report import (
    KPI_ORDER,
    extract_invoice_lines,
    render_html,
    send_email,
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
        ):
            with self.subTest(category=category):
                self.assertTrue(should_exclude_category(category))

    def test_report_validation_blocks_excluded_rows_before_email(self) -> None:
        report = {"staff_rows": [{"staff_name": "RM. Ryan Barrett"}]}

        with self.assertRaisesRegex(RuntimeError, "excluded non-staff"):
            validate_report(report)


class InvoiceLineExtractionTest(unittest.TestCase):
    def test_extracts_nested_bigchange_invoice_lines(self) -> None:
        document = {"Result": {"FinancialDoc": {"InvoiceLines": {"InvoiceLine": [{"NetPrice": "120", "VatAmount": "20"}]}}}}

        self.assertEqual(extract_invoice_lines(document), [{"NetPrice": "120", "VatAmount": "20"}])


class RenderHtmlTest(unittest.TestCase):
    def test_current_month_sales_column_follows_kpi_columns(self) -> None:
        metrics = {
            metric_key: {"count": 0, "oldest_age_days": 0, "status": "green"}
            for metric_key, _label in KPI_ORDER
        }
        html = render_html(
            {
                "run_timestamp": "2026-05-20T07:00:00+00:00",
                "report_date": "2026-05-20",
                "job_lookback_start": "2025-05-20",
                "month_name": "May",
                "total_red_kpis": 0,
                "total_amber_kpis": 0,
                "staff_rows": [
                    {
                        "staff_name": "Sharon Mannion",
                        "metrics": metrics,
                        "current_month_sales_display": "GBP 1,234.00",
                        "total_open_workload": 0,
                    }
                ],
            }
        )

        self.assertLess(html.index("<th>Unactioned Jobs</th>"), html.index("<th>May sales</th>"))
        self.assertLess(html.index('class="age">0 days old</div></div></td><td><div class="sales-value"'), html.index("GBP 1,234.00"))


class SendEmailTest(unittest.TestCase):
    def test_embeds_and_attaches_one_png_part_only(self) -> None:
        sent: dict[str, str] = {}

        class FakeSMTP:
            def __init__(self, *args, **kwargs) -> None:
                pass

            def __enter__(self) -> "FakeSMTP":
                return self

            def __exit__(self, *args) -> None:
                pass

            def starttls(self) -> None:
                pass

            def login(self, username: str, password: str) -> None:
                sent["login"] = username

            def sendmail(self, from_email: str, recipients: list[str], message: str) -> None:
                sent["from"] = from_email
                sent["recipients"] = ",".join(recipients)
                sent["message"] = message

        env = {
            "SMTP_HOST": "smtp.example.test",
            "SMTP_PORT": "587",
            "SMTP_USERNAME": "user@example.test",
            "SMTP_PASSWORD": "password",
            "SMTP_FROM_EMAIL": "from@example.test",
            "SMTP_FROM_NAME": "Daniel Dwyer",
            "SMTP_TO_EMAIL": "to@example.test",
            "SMTP_CC_EMAIL": "cc@example.test",
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            png_path = Path(tmpdir) / "dashboard.png"
            png_path.write_bytes(b"png-bytes")
            with patch.dict("os.environ", env, clear=True), patch("scripts.bigchange_kpi_report.smtplib.SMTP", FakeSMTP):
                send_email(png_path)

        message = message_from_string(sent["message"])
        png_parts = [part for part in message.walk() if part.get_content_type() == "image/png"]

        self.assertEqual(len(png_parts), 1)
        self.assertEqual(png_parts[0]["Content-ID"], "<kpi-dashboard>")
        self.assertIn("attachment", png_parts[0].get("Content-Disposition", ""))


if __name__ == "__main__":
    unittest.main()
