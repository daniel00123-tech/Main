import datetime as dt
import email
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.bigchange_kpi_report import build_report, calculate_sales, code_is_success, match_staff_name, name_key
from scripts.bigchange_kpi_report import render_html, save_baseline, send_email, should_exclude_category, validate_report


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


class ReportBuildTest(unittest.TestCase):
    def test_builds_bigchange_only_rows_and_sorts_best_to_worst(self) -> None:
        client = FakeReportBigChangeClient()

        with patch("scripts.bigchange_kpi_report.dt.date", FixedDate):
            report = build_report(client)

        self.assertEqual([row["staff_name"] for row in report["staff_rows"]], ["Amy Bradley", "Leah Hearn", "Sharon Mannion"])
        amy, leah, sharon = report["staff_rows"]
        self.assertEqual(amy["red_kpis"], 0)
        self.assertEqual(amy["amber_kpis"], 0)
        self.assertEqual(amy["total_open_workload"], 0)
        self.assertEqual(leah["amber_kpis"], 1)
        self.assertEqual(sharon["red_kpis"], 1)
        self.assertEqual(sharon["metrics"]["unallocated_jobs"]["oldest_age_days"], 36)
        self.assertEqual(sharon["current_month_sales"], 100.0)

    def test_rendered_dashboard_uses_requested_columns_only(self) -> None:
        report = sample_report()

        html = render_html(report)

        self.assertIn("Unallocated Jobs", html)
        self.assertIn("Historic Jobs", html)
        self.assertIn("Uninvoiced Jobs", html)
        self.assertIn("Unactioned Jobs", html)
        self.assertIn("June sales", html)
        self.assertNotIn("Freshdesk", html)
        self.assertNotIn("Overall Score", html)


class BaselineAndEmailTest(unittest.TestCase):
    def test_saves_baseline_with_requested_kpi_fields(self) -> None:
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

        self.assertEqual(set(baseline["staff"][0]["counts"]), {"unallocated_jobs", "historic_jobs", "uninvoiced_jobs", "unactioned_jobs"})
        self.assertEqual(baseline["staff"][0]["current_month_sales"], 123.45)
        self.assertNotIn("freshdesk_ticket_count", baseline["staff"][0])
        self.assertNotIn("overall_score", baseline["staff"][0])

    def test_email_embeds_and_attaches_only_png(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            png_path = Path(temp_dir) / "dashboard.png"
            png_path.write_bytes(b"\x89PNG\r\n\x1a\n")
            sent_messages: list[str] = []

            class FakeSMTP:
                def __init__(self, host, port, timeout):
                    self.host = host
                    self.port = port
                    self.timeout = timeout

                def __enter__(self):
                    return self

                def __exit__(self, exc_type, exc, tb):
                    return None

                def starttls(self):
                    return None

                def login(self, username, password):
                    return None

                def sendmail(self, from_email, recipients, message):
                    sent_messages.append(message)

            env = {
                "SMTP_HOST": "smtp.example.test",
                "SMTP_PORT": "587",
                "SMTP_USERNAME": "user",
                "SMTP_PASSWORD": "pass",
                "SMTP_FROM_EMAIL": "sender@example.test",
                "SMTP_FROM_NAME": "Daniel Dwyer",
                "SMTP_TO_EMAIL": "team@example.test",
                "SMTP_CC_EMAIL": "cc@example.test",
            }
            with patch.dict(os.environ, env), patch("scripts.bigchange_kpi_report.smtplib.SMTP", FakeSMTP):
                send_email(png_path)

        message = email.message_from_string(sent_messages[0])
        attachments = [
            part
            for part in message.walk()
            if part.get_content_disposition() == "attachment"
        ]
        html_parts = [
            part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8")
            for part in message.walk()
            if part.get_content_type() == "text/html"
        ]
        self.assertEqual(len(attachments), 1)
        self.assertEqual(attachments[0].get_content_type(), "image/png")
        self.assertEqual(attachments[0].get_filename(), "dashboard.png")
        self.assertEqual(len(html_parts), 1)
        self.assertIn("cid:kpi-dashboard", html_parts[0])


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
        return cls(2026, 6, 6)


class FakeReportBigChangeClient:
    def categories(self):
        return [
            {"Name": "Amy Bradley"},
            {"Name": "Leah Hearn"},
            {"Name": "Sharon Mannion"},
            {"Name": "Nirvana PPM"},
            {"Name": "OOH reactive"},
        ]

    def jobslist(self, params):
        if params.get("Unallocated"):
            return [
                {"Category": "Sharon Mannion", "StatusId": 1, "Created": "2026-05-01"},
                {"Category": "Nirvana PPM", "StatusId": 1, "Created": "2026-04-01"},
                {"Category": "Leah Hearn", "StatusId": 1, "ResourceName": "Engineer", "Created": "2026-05-28"},
            ]
        if params.get("Allocated"):
            return [
                {
                    "Category": "Leah Hearn",
                    "StatusId": 5,
                    "ResourceName": "Engineer",
                    "PlannedStart": "2026-05-25 08:00:00",
                },
                {
                    "Category": "Amy Bradley",
                    "StatusId": 12,
                    "ResourceName": "Engineer",
                    "PlannedStart": "2026-05-20 08:00:00",
                },
            ]
        if params.get("ClientStatusId") == -34:
            return [
                {
                    "Category": "Sharon Mannion",
                    "StatusId": 12,
                    "ClientStatusId": -34,
                    "CompletedDate": "2026-06-02",
                }
            ]
        if params.get("Unactioned"):
            return [
                {
                    "Category": "Amy Bradley",
                    "StatusId": 12,
                    "Actioned": "yes",
                    "CompletedDate": "2026-06-02",
                }
            ]
        return []

    def invoices_with_items_by_period(self, start, end):
        return [
            {
                "OrderType": "Invoice",
                "JobId": "job-1",
                "Lines": [{"NetPrice": "120.00", "VatAmount": "20.00"}],
            }
        ]

    def job_customer_activity(self, job_id):
        return [
            {"JobClientStatusID": 34, "JobClientStatusDate": "2026-06-05", "JobClientStatusOwner": "Sharon Mannion"}
        ]


def sample_report():
    metrics = {
        "unallocated_jobs": {"count": 0, "status": "green", "oldest_age_days": 0},
        "historic_jobs": {"count": 1, "status": "amber", "oldest_age_days": 12},
        "uninvoiced_jobs": {"count": 0, "status": "green", "oldest_age_days": 0},
        "unactioned_jobs": {"count": 0, "status": "green", "oldest_age_days": 0},
    }
    return {
        "run_timestamp": "2026-06-06T07:00:00+00:00",
        "report_date": "2026-06-06",
        "job_lookback_start": "2025-06-06",
        "month_name": "June",
        "staff_rows": [
            {
                "staff_name": "Amy Bradley",
                "metrics": metrics,
                "current_month_sales": 123.45,
                "current_month_sales_display": "GBP 123.45",
                "red_kpis": 0,
                "amber_kpis": 1,
                "total_open_workload": 1,
            }
        ],
        "total_red_kpis": 0,
        "total_amber_kpis": 1,
    }


if __name__ == "__main__":
    unittest.main()
