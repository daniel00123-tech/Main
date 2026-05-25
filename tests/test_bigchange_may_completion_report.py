import datetime as dt
import unittest

from scripts.bigchange_may_completion_report import (
    completed_from_historic_event,
    count_invoiced_jobs,
    latest_job_card_sent_owner,
    month_period,
    scheduled_from_unallocated_event,
)
from scripts.bigchange_kpi_report import name_key


class PeriodTest(unittest.TestCase):
    def test_month_period_returns_inclusive_end_and_exclusive_boundary(self) -> None:
        start, end, end_exclusive = month_period(2026, 5)

        self.assertEqual(start, dt.date(2026, 5, 1))
        self.assertEqual(end, dt.date(2026, 5, 31))
        self.assertEqual(end_exclusive, dt.date(2026, 6, 1))


class StatusHistoryTest(unittest.TestCase):
    def test_detects_scheduled_transition_from_unallocated_status(self) -> None:
        history = [
            {"JobStatusID": 1, "JobStatusDate": "2026-04-30 09:00:00", "JobStatusOwner": "Amy Marshall"},
            {"JobStatusID": 2, "JobStatusDate": "2026-05-02 10:00:00", "JobStatusOwner": "Amy Marshall"},
        ]

        event = scheduled_from_unallocated_event(history, dt.date(2026, 5, 1), dt.date(2026, 5, 31))

        self.assertIsNotNone(event)
        self.assertEqual(event["JobStatusOwner"], "Amy Marshall")

    def test_ignores_scheduled_transition_from_started_status(self) -> None:
        history = [
            {"JobStatusID": 10, "JobStatusDate": "2026-05-02 09:00:00", "JobStatusOwner": "Engineer"},
            {"JobStatusID": 2, "JobStatusDate": "2026-05-02 10:00:00", "JobStatusOwner": "Engineer"},
        ]

        event = scheduled_from_unallocated_event(history, dt.date(2026, 5, 1), dt.date(2026, 5, 31))

        self.assertIsNone(event)

    def test_detects_completed_job_that_was_historic_at_completion(self) -> None:
        job = {"PlannedStart": "2026-04-25 08:00:00"}
        history = [
            {"JobStatusID": 2, "JobStatusDate": "2026-04-20 09:00:00", "JobStatusOwner": "Lucy Fisher"},
            {"JobStatusID": 12, "JobStatusDate": "2026-05-07 15:20:00", "JobStatusOwner": "Lucy Fisher"},
        ]

        event = completed_from_historic_event(job, history, dt.date(2026, 5, 1), dt.date(2026, 5, 31))

        self.assertIsNotNone(event)
        self.assertEqual(event["JobStatusOwner"], "Lucy Fisher")


class ActivityTest(unittest.TestCase):
    def test_uses_latest_may_job_card_sent_owner(self) -> None:
        activity = [
            {
                "JobClientStatusID": 30,
                "JobClientStatusDate": "2026-05-03 10:00:00",
                "JobClientStatusOwner": "Earlier User",
            },
            {
                "JobClientStatusID": 30,
                "JobClientStatusDate": "2026-05-04 10:00:00",
                "JobClientStatusOwner": "Latest User",
            },
        ]

        owner = latest_job_card_sent_owner(activity, dt.date(2026, 5, 1), dt.date(2026, 5, 31))

        self.assertEqual(owner, "Latest User")


class InvoiceCountTest(unittest.TestCase):
    def test_counts_active_invoices_by_creator_and_dedupes_jobs(self) -> None:
        client = FakeClient(
            [
                {"OrderType": "Invoice", "OrderCreator": "1", "JobId": "101", "DocumentId": "A"},
                {"OrderType": "Invoice", "OrderCreator": "1", "JobId": "101", "DocumentId": "B"},
                {"OrderType": "Invoice", "OrderCreator": "2", "JobId": "", "DocumentId": "C"},
                {"OrderType": "Invoice", "OrderCreator": "1", "JobId": "102", "Cancelled": "true", "DocumentId": "D"},
            ]
        )
        staff_by_key = {name_key("Amy Marshall"): "Amy Marshall"}
        web_users = {"1": "Amy Marshall", "2": "Luis Legrove"}

        counts = count_invoiced_jobs(client, staff_by_key, web_users, dt.date(2026, 5, 1), dt.date(2026, 5, 31))

        self.assertEqual(counts["Amy Marshall"], 1)
        self.assertEqual(counts["Luis Legrove"], 1)


class FakeClient:
    def __init__(self, invoices):
        self._invoices = invoices

    def invoices_with_items_by_period(self, start, end):
        return self._invoices


if __name__ == "__main__":
    unittest.main()
