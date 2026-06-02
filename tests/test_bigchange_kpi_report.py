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
    category_lookup,
    code_is_success,
    is_open_freshdesk_ticket,
    match_staff_name,
    name_key,
    resolved_job_category_name,
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


class BigChangeApiTest(unittest.TestCase):
    def test_accepts_legacy_success_code_shapes(self) -> None:
        self.assertTrue(code_is_success({"Code": 0}))
        self.assertTrue(code_is_success({"Code": "0"}))
        self.assertFalse(code_is_success({"Code": 1}))

    def test_resolves_job_category_name_from_category_id_lookup(self) -> None:
        categories_by_id = category_lookup(
            [
                {"Id": 101, "Name": "Amy Bradley"},
                {"JobCategoryID": "202", "JobCategoryName": "Daniel Dwyer"},
            ]
        )

        self.assertEqual(resolved_job_category_name({"JobCategoryId": "101"}, categories_by_id), "Amy Bradley")
        self.assertEqual(resolved_job_category_name({"CategoryID": 202}, categories_by_id), "Daniel Dwyer")

    def test_prefers_embedded_job_category_name_over_lookup(self) -> None:
        categories_by_id = category_lookup([{"Id": 101, "Name": "Amy Bradley"}])

        self.assertEqual(
            resolved_job_category_name({"JobCategoryId": "101", "JobCategoryName": "Sharon Mannion"}, categories_by_id),
            "Sharon Mannion",
        )

    def test_does_not_treat_generic_job_fields_as_category_fields(self) -> None:
        categories_by_id = category_lookup([{"Id": 101, "Name": "Amy Bradley"}])

        self.assertEqual(resolved_job_category_name({"Id": 101, "Name": "Repair leaking tap"}, categories_by_id), "")


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

    def test_maps_nested_status_choices_to_open_status_ids(self) -> None:
        choices = {"2": ["Open", "Open"], "3": ["Pending", "Pending"], "5": ["Closed", "Closed"]}

        self.assertEqual(status_ids_from_choices(choices), {2, 3})

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


class EmailDeliveryTest(unittest.TestCase):
    def test_embeds_png_and_attaches_only_png(self) -> None:
        env = {
            "SMTP_HOST": "smtp.example.com",
            "SMTP_PORT": "587",
            "SMTP_USERNAME": "user@example.com",
            "SMTP_PASSWORD": "secret",
            "SMTP_FROM_EMAIL": "sender@example.com",
            "SMTP_FROM_NAME": "Sender Name",
            "SMTP_TO_EMAIL": "team@example.com",
            "SMTP_CC_EMAIL": "manager@example.com",
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            png_path = Path(temp_dir) / "dashboard.png"
            png_path.write_bytes(b"\x89PNG\r\n\x1a\n")

            with patch.dict(os.environ, env, clear=False), patch("scripts.bigchange_kpi_report.smtplib.SMTP") as smtp_cls:
                smtp = smtp_cls.return_value.__enter__.return_value
                send_email(png_path)

        raw_message = smtp.sendmail.call_args.args[2]
        message = email.message_from_string(raw_message)
        attachments = [part for part in message.walk() if part.get_content_disposition() == "attachment"]

        self.assertEqual(len(attachments), 1)
        self.assertEqual(attachments[0].get_content_type(), "image/png")
        self.assertEqual(attachments[0].get_filename(), "dashboard.png")
        self.assertEqual(attachments[0]["Content-ID"], "<kpi-dashboard>")
        self.assertNotIn("application/json", [part.get_content_type() for part in attachments])
        self.assertNotIn("text/html", [part.get_content_type() for part in attachments])


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
