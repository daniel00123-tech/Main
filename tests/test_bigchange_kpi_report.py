import datetime as dt
import email
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.bigchange_kpi_report import (
    calculate_sales,
    match_staff_name,
    name_key,
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


class EmailPackagingTest(unittest.TestCase):
    def test_embeds_and_attaches_single_png_only(self) -> None:
        sent_messages = []

        class FakeSMTP:
            def __init__(self, *args, **kwargs) -> None:
                pass

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, traceback) -> None:
                pass

            def starttls(self) -> None:
                pass

            def login(self, username, password) -> None:
                pass

            def sendmail(self, from_email, recipients, message) -> None:
                sent_messages.append(message)

        env = {
            "SMTP_HOST": "smtp.example.com",
            "SMTP_PORT": "587",
            "SMTP_USERNAME": "user@example.com",
            "SMTP_PASSWORD": "password",
            "SMTP_FROM_EMAIL": "from@example.com",
            "SMTP_FROM_NAME": "Daniel Dwyer",
            "SMTP_TO_EMAIL": "to@example.com",
            "SMTP_CC_EMAIL": "cc@example.com",
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            png_path = Path(tmpdir) / "dashboard.png"
            png_path.write_bytes(b"\x89PNG\r\n\x1a\n")

            with patch.dict("os.environ", env, clear=True), patch("scripts.bigchange_kpi_report.smtplib.SMTP", FakeSMTP):
                send_email(png_path)

        message = email.message_from_string(sent_messages[0])
        parts = list(message.walk())
        png_parts = [part for part in parts if part.get_content_type() == "image/png"]
        attachments = [part for part in parts if part.get_content_disposition() == "attachment"]

        self.assertEqual(len(png_parts), 1)
        self.assertEqual(len(attachments), 1)
        self.assertEqual(attachments[0].get_filename(), "dashboard.png")
        self.assertEqual(png_parts[0]["Content-ID"], "<kpi-dashboard>")


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
