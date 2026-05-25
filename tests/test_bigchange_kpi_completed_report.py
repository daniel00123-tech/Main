import unittest

from scripts.bigchange_kpi_completed_report import (
    eligible_invoice_documents,
    historic_completed_event,
    scheduled_from_unallocated_event,
)


class CompletedMovementReportTest(unittest.TestCase):
    def test_detects_latest_scheduled_transition_after_unallocated_status(self) -> None:
        event = scheduled_from_unallocated_event(
            [
                {"JobStatusID": 1, "JobStatusDate": "2026-04-30 09:00:00", "JobStatusOwner": "Amy Bradley"},
                {"JobStatusID": 2, "JobStatusDate": "2026-05-02 10:00:00", "JobStatusOwner": "Amy Bradley"},
                {"JobStatusID": 4, "JobStatusDate": "2026-05-02 10:05:00", "JobStatusOwner": "Engineer"},
                {"JobStatusID": 3, "JobStatusDate": "2026-05-08 08:00:00", "JobStatusOwner": "Amy Bradley"},
                {"JobStatusID": 2, "JobStatusDate": "2026-05-09 08:30:00", "JobStatusOwner": "Laura Menegon"},
            ]
        )

        self.assertIsNotNone(event)
        self.assertEqual(event["JobStatusOwner"], "Laura Menegon")

    def test_historic_completed_requires_planned_start_before_completion_date(self) -> None:
        event = historic_completed_event(
            {"PlannedStart": "2026-04-28 08:00:00"},
            [
                {
                    "JobStatusID": 12,
                    "JobStatusDate": "2026-05-01 14:00:00",
                    "JobStatusOwner": "Nailah Toyer",
                }
            ],
        )

        self.assertIsNotNone(event)
        self.assertEqual(event["JobStatusOwner"], "Nailah Toyer")

    def test_filters_invoice_documents_to_billable_live_job_links(self) -> None:
        docs = eligible_invoice_documents(
            [
                {"OrderType": "Invoice", "JobId": "101"},
                {"OrderType": "Credit", "JobId": "102"},
                {"OrderType": "Invoice", "JobId": "103", "Cancelled": "true"},
                {"OrderType": "Invoice"},
            ]
        )

        self.assertEqual(docs, [{"OrderType": "Invoice", "JobId": "101"}])


if __name__ == "__main__":
    unittest.main()
