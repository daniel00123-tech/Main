import datetime as dt
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.bigchange_kpi_report import (
    build_email_message,
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


class EmailMessageTest(unittest.TestCase):
    def test_dashboard_png_is_the_only_file_part(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            png_path = Path(temp_dir) / "dashboard.png"
            png_path.write_bytes(b"\x89PNG\r\n\x1a\n")

            with patch.dict(
                "os.environ",
                {
                    "SMTP_FROM_EMAIL": "sender@example.com",
                    "SMTP_FROM_NAME": "Sender",
                    "SMTP_TO_EMAIL": "team@example.com",
                    "SMTP_CC_EMAIL": "manager@example.com",
                },
                clear=False,
            ):
                message, from_email, recipients = build_email_message(png_path)

        image_parts = [part for part in message.walk() if part.get_content_type() == "image/png"]
        file_parts = [part for part in message.walk() if part.get_filename()]

        self.assertEqual(from_email, "sender@example.com")
        self.assertEqual(recipients, ["team@example.com", "manager@example.com"])
        self.assertEqual(len(image_parts), 1)
        self.assertEqual(file_parts, image_parts)
        self.assertEqual(image_parts[0]["Content-ID"], "<kpi-dashboard>")
        self.assertEqual(image_parts[0].get_content_disposition(), "attachment")


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
