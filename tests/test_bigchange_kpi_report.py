import datetime as dt
import email
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.bigchange_kpi_report import (
    FRESHDESK_METRIC,
    calculate_freshdesk_metrics,
    calculate_sales,
    calculate_score,
    is_open_freshdesk_ticket,
    match_staff_name,
    name_key,
    render_html,
    save_baseline,
    send_email,
    should_exclude_category,
    status_ids_from_choices,
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
            ],
            activities={
                "101": [{"JobClientStatusID": 34, "JobClientStatusDate": "2026-05-02", "JobClientStatusOwner": "Sharon Mannion"}],
                "102": [{"JobClientStatusID": 34, "JobClientStatusDate": "2026-05-03", "JobClientStatusOwner": "Sharon Mannion"}],
                "103": [{"JobClientStatusID": 34, "JobClientStatusDate": "2026-05-04", "JobClientStatusOwner": "Sharon Mannion"}],
                "104": [{"JobClientStatusName": "InvoiceCreated", "ActivityDate": "2026-05-05", "ClientStatusOwner": "Amy B"}],
            },
        )

        sales = calculate_sales(client, {"Sharon Mannion", "Amy Bradley"}, dt.date(2026, 5, 1), dt.date(2026, 5, 20))

        self.assertEqual(sales["Sharon Mannion"], 170)
        self.assertEqual(sales["Amy Bradley"], 10)


class FreshdeskKpiTest(unittest.TestCase):
    def test_maps_status_choices_to_open_status_ids(self) -> None:
        choices = [
            {"id": 2, "value": "Open"},
            {"id": 3, "value": "Pending"},
            {"id": 4, "value": "Resolved"},
            {"id": 8, "value": "Waiting on Customer"},
            {"id": 9, "value": "Waiting on Third Party"},
        ]

        self.assertEqual(status_ids_from_choices(choices), {2, 3, 8, 9})

    def test_filters_deleted_spam_and_closed_tickets(self) -> None:
        open_status_ids = {2, 3, 8, 9}

        self.assertTrue(is_open_freshdesk_ticket({"status": 8}, open_status_ids))
        self.assertTrue(is_open_freshdesk_ticket({"status": 99, "status_name": "Waiting on Third Party"}, open_status_ids))
        self.assertFalse(is_open_freshdesk_ticket({"status": 8, "spam": True}, open_status_ids))
        self.assertFalse(is_open_freshdesk_ticket({"status": 8, "deleted": True}, open_status_ids))
        self.assertFalse(is_open_freshdesk_ticket({"status": 5}, open_status_ids))

    def test_groups_tickets_by_matched_staff_and_tracks_unmatched_and_critical(self) -> None:
        client = FakeFreshdeskClient(
            tickets=[
                {"id": 1, "status": 2, "responder_id": 10, "created_at": "2026-05-20T08:00:00Z"},
                {"id": 2, "status": 3, "requester_id": 20, "created_at": "2026-04-10T08:00:00Z"},
                {"id": 3, "status": 3, "requester": {"name": "Unknown Owner"}, "created_at": "2026-05-01T08:00:00Z"},
            ],
            agents={10: "Amy B"},
            contacts={20: "Dan Dwyer"},
        )

        grouped, unmatched, critical = calculate_freshdesk_metrics(
            client, {"Amy Bradley", "Daniel Dwyer"}, dt.date(2026, 5, 25)
        )

        self.assertEqual(len(grouped["Amy Bradley"]), 1)
        self.assertEqual(len(grouped["Daniel Dwyer"]), 1)
        self.assertEqual(len(unmatched), 1)
        self.assertEqual(len(critical), 1)


class ScoreAndBaselineTest(unittest.TestCase):
    def test_calculates_score_from_status_penalties_and_workload(self) -> None:
        metrics = {
            "unallocated_jobs": {"count": 2, "status": "green"},
            "historic_jobs": {"count": 4, "status": "amber"},
            "uninvoiced_jobs": {"count": 1, "status": "red"},
            "unactioned_jobs": {"count": 0, "status": "green"},
            FRESHDESK_METRIC[0]: {"count": 3, "status": "green"},
        }

        self.assertEqual(calculate_score(metrics), 60)

    def test_saves_baseline_with_freshdesk_age_and_score_fields(self) -> None:
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
                        FRESHDESK_METRIC[0]: {"count": 2, "status": "red", "oldest_age_days": 31},
                    },
                    "current_month_sales": 123.45,
                    "freshdesk_ticket_count": 2,
                    "overall_score": 67,
                }
            ],
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "kpi-baseline.json"
            save_baseline(report, path)

            baseline = json.loads(path.read_text(encoding="utf-8"))

        self.assertEqual(baseline["staff"][0]["freshdesk_ticket_count"], 2)
        self.assertEqual(baseline["staff"][0]["overall_score"], 67)
        self.assertEqual(baseline["staff"][0]["oldest_age_days"][FRESHDESK_METRIC[0]], 31)

    def test_dashboard_keeps_overall_score_private(self) -> None:
        report = {
            "run_timestamp": "2026-05-25T07:00:00+00:00",
            "report_date": "2026-05-25",
            "job_lookback_start": "2025-05-25",
            "month_name": "May",
            "total_red_kpis": 0,
            "total_amber_kpis": 0,
            "unmatched_freshdesk_ticket_count": 0,
            "critical_freshdesk_ticket_count": 0,
            "critical_freshdesk_oldest_age_days": 0,
            "staff_rows": [
                {
                    "staff_name": "Amy Bradley",
                    "metrics": {
                        "unallocated_jobs": {"count": 0, "status": "green", "oldest_age_days": 0},
                        "historic_jobs": {"count": 0, "status": "green", "oldest_age_days": 0},
                        "uninvoiced_jobs": {"count": 0, "status": "green", "oldest_age_days": 0},
                        "unactioned_jobs": {"count": 0, "status": "green", "oldest_age_days": 0},
                        FRESHDESK_METRIC[0]: {"count": 0, "status": "green", "oldest_age_days": 0},
                    },
                    "current_month_sales": 0,
                    "current_month_sales_display": "GBP 0.00",
                    "freshdesk_ticket_count": 0,
                    "red_kpis": 0,
                    "amber_kpis": 0,
                    "total_open_workload": 0,
                    "overall_score": 67,
                    "score_status": "amber",
                    "escalated": False,
                }
            ],
        }

        rendered = render_html(report)

        self.assertNotIn(">67<", rendered)
        self.assertNotIn("/ 100", rendered)
        self.assertIn("Private score", rendered)


class EmailTest(unittest.TestCase):
    def test_email_embeds_and_attaches_only_png(self) -> None:
        sent_messages: list[str] = []

        class FakeSMTP:
            def __init__(self, *_args, **_kwargs) -> None:
                pass

            def __enter__(self):
                return self

            def __exit__(self, *_args) -> None:
                pass

            def starttls(self) -> None:
                pass

            def login(self, _username, _password) -> None:
                pass

            def sendmail(self, _from_email, _recipients, message) -> None:
                sent_messages.append(message)

        with tempfile.TemporaryDirectory() as temp_dir:
            png_path = Path(temp_dir) / "dashboard.png"
            png_path.write_bytes(b"\x89PNG\r\n\x1a\n")
            env = {
                "SMTP_HOST": "smtp.example.com",
                "SMTP_PORT": "587",
                "SMTP_USERNAME": "user",
                "SMTP_PASSWORD": "password",
                "SMTP_FROM_EMAIL": "from@example.com",
                "SMTP_FROM_NAME": "Daniel Dwyer",
                "SMTP_TO_EMAIL": "to@example.com",
                "SMTP_CC_EMAIL": "cc@example.com",
            }
            with patch.dict(os.environ, env, clear=False), patch("scripts.bigchange_kpi_report.smtplib.SMTP", FakeSMTP):
                send_email(png_path)

        self.assertEqual(len(sent_messages), 1)
        message = email.message_from_string(sent_messages[0])
        attachments = [
            part
            for part in message.walk()
            if part.get_content_disposition() == "attachment"
        ]
        self.assertEqual(len(attachments), 1)
        self.assertEqual(attachments[0].get_content_type(), "image/png")
        self.assertEqual(attachments[0].get_filename(), "dashboard.png")
        html_parts = [
            part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8")
            for part in message.walk()
            if part.get_content_type() == "text/html"
        ]
        self.assertTrue(any("cid:kpi-dashboard" in part for part in html_parts))


class FakeBigChangeClient:
    def __init__(self, invoices, activities) -> None:
        self._invoices = invoices
        self._activities = activities

    def invoices_with_items_by_period(self, start, end):
        return self._invoices

    def job_customer_activity(self, job_id):
        return self._activities.get(job_id, [])


class FakeFreshdeskClient:
    def __init__(self, tickets, agents, contacts) -> None:
        self._tickets = tickets
        self._agents = agents
        self._contacts = contacts

    def list_open_tickets(self):
        return self._tickets

    def agent_name(self, agent_id):
        return self._agents.get(agent_id, "")

    def contact_name(self, contact_id):
        return self._contacts.get(contact_id, "")


if __name__ == "__main__":
    unittest.main()
