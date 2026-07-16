import csv
import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path

from scripts.dandara_appointment_confirmations import (
    EntityNotFoundError,
    MESSAGE_TEMPLATE,
    choose_recipient,
    classify_dandara,
    extract_issue_ids,
    identify_site,
    is_confirmation_for_date,
    run,
)


def issue(
    *,
    issue_id: str,
    status: str = "AwaitingJobCompletion",
    job_id: str = "JB12345678",
    tenant_id: str = "",
    tenant_presence: bool = False,
    agent_email: str = "repairs@example.com",
    address: str = "",
) -> dict:
    return {
        "Id": issue_id,
        "Status": status,
        "Job": {"Id": job_id} if job_id else None,
        "TenantId": tenant_id,
        "TenantPresenceRequested": tenant_presence,
        "AssignedAgent": {"EmailAddress": agent_email},
        "Address": address,
    }


def job(
    *,
    job_id: int,
    planned: str,
    issue_id: str = "",
    group: str = "",
    location: str = "",
    status_id: int = 2,
) -> dict:
    return {
        "JobId": job_id,
        "Ref": f"BC-{job_id}",
        "JobPO": issue_id,
        "JobGroup": group,
        "Description": "",
        "Location": location,
        "PlannedStart": planned,
        "StatusId": status_id,
    }


class FakeBigChange:
    def __init__(self, rows):
        self.rows = rows
        self.calls = []

    def jobs(self, start, end):
        self.calls.append((start, end))
        return self.rows


class FakeFixFlo:
    def __init__(self, issues, comments=None):
        self.issues = issues
        self.comments = comments or {}
        self.posts = []

    def get_issue(self, issue_id):
        value = self.issues[issue_id]
        if isinstance(value, Exception):
            raise value
        return value

    def get_comments(self, issue_id):
        value = self.comments.get(issue_id, [])
        if isinstance(value, Exception):
            raise value
        return value

    def post_comment(self, issue_id, date_text, recipient):
        self.posts.append((issue_id, date_text, recipient))
        return {"Id": 1000 + len(self.posts)}


class ClassificationTest(unittest.TestCase):
    def test_extracts_only_is_references_from_supported_fields(self):
        row = {
            "JobPO": "IS22870769",
            "Description": "Follow-up for is22870770",
            "Unrelated": "IS99999999",
        }

        self.assertEqual(extract_issue_ids(row), ["IS22870769", "IS22870770"])

    def test_identifies_confirmed_sites_and_requires_link_for_armouries(self):
        self.assertEqual(identify_site("Flat 1, Aaron House"), "Leodis Square, Leeds")
        self.assertEqual(identify_site("Stoneywood Brae, Dyce"), "Stoneywood Brae, Aberdeen / Dyce")
        self.assertEqual(identify_site("The Armouries, Birmingham"), "")
        self.assertEqual(
            identify_site("The Armouries, Birmingham", explicit_dandara=True),
            "Armouries, Birmingham",
        )

    def test_classifies_by_group_agent_or_confirmed_site(self):
        self.assertTrue(classify_dandara({"JobGroup": "Dandara - IS22870769"}, issue(issue_id="IS22870769"))[0])
        self.assertTrue(
            classify_dandara(
                {"JobGroup": "Other"},
                issue(issue_id="IS22870769", agent_email="team@dandaraliving.com"),
            )[0]
        )
        self.assertEqual(
            classify_dandara(
                {"JobGroup": "Other", "Location": "Flat 2, Granary Quay"},
                issue(issue_id="IS22870769"),
            ),
            (True, "Granary Quay, Glasgow"),
        )

    def test_recipient_requires_tenant_and_presence_request(self):
        self.assertEqual(choose_recipient(issue(issue_id="IS1", tenant_id="TN1", tenant_presence=True)), "Tenant")
        self.assertEqual(choose_recipient(issue(issue_id="IS1", tenant_id="TN1", tenant_presence=False)), "Agent")
        self.assertEqual(choose_recipient(issue(issue_id="IS1", tenant_id="", tenant_presence=True)), "Agent")

    def test_confirmation_requires_phrase_and_matching_date(self):
        message = MESSAGE_TEMPLATE.format(date="17/07/2026")
        self.assertTrue(is_confirmation_for_date({"Message": message}, "17/07/2026"))
        self.assertFalse(is_confirmation_for_date({"Message": message}, "18/07/2026"))
        self.assertFalse(is_confirmation_for_date({"Message": "Visit 17/07/2026"}, "17/07/2026"))


class RunTest(unittest.TestCase):
    def run_in_temp(self, rows, issues, comments=None, state=None, dry_run=False):
        with tempfile.TemporaryDirectory() as directory:
            artifacts = Path(directory)
            if state is not None:
                (artifacts / "dandara-confirmation-state.json").write_text(
                    json.dumps({"version": 1, "issues": state}),
                    encoding="utf-8",
                )
            fixflo = FakeFixFlo(issues, comments)
            result = run(
                FakeBigChange(rows),
                fixflo,
                today=dt.date(2026, 7, 16),
                artifacts_dir=artifacts,
                dry_run=dry_run,
            )
            with (artifacts / "dandara-confirmation-candidates.csv").open(encoding="utf-8") as handle:
                candidates = list(csv.DictReader(handle))
            results_file = json.loads((artifacts / "dandara-confirmation-results.json").read_text())
            saved_state = (
                json.loads((artifacts / "dandara-confirmation-state.json").read_text())
                if (artifacts / "dandara-confirmation-state.json").exists()
                else None
            )
            return result, fixflo.posts, candidates, results_file, saved_state

    def test_filters_scope_and_posts_to_tenant_or_agent(self):
        rows = [
            job(job_id=1, planned="2026-07-17 09:00:00", group="Dandara - IS22870001", issue_id="IS22870001"),
            job(job_id=2, planned="2026-07-18 09:00:00", group="Dandara - IS22870002", issue_id="IS22870002"),
            job(job_id=3, planned="2026-07-19 09:00:00", group="Other", issue_id="IS22870003"),
            job(job_id=4, planned="2026-07-20 09:00:00"),
            job(job_id=5, planned="2026-08-02 09:00:00", group="Dandara - IS22870005", issue_id="IS22870005"),
            job(job_id=6, planned="2026-07-21 09:00:00", group="Dandara - IS22870006", issue_id="IS22870006"),
            job(job_id=7, planned="2026-07-22 09:00:00", group="Dandara - IS22870007", issue_id="IS22870007"),
        ]
        issues = {
            "IS22870001": issue(
                issue_id="IS22870001",
                tenant_id="TN1",
                tenant_presence=True,
                address="Aaron House",
            ),
            "IS22870002": issue(issue_id="IS22870002", address="Chapel Wharf"),
            "IS22870003": issue(issue_id="IS22870003"),
            "IS22870006": issue(issue_id="IS22870006", status="Closed"),
            "IS22870007": issue(issue_id="IS22870007", job_id=""),
        }

        result, posts, candidates, results_file, saved_state = self.run_in_temp(rows, issues)
        summary = result["summary"]

        self.assertEqual(summary["bigchange_jobs_with_is"], 5)
        self.assertEqual(summary["non_fixflo_skipped"], 1)
        self.assertEqual(summary["non_dandara_skipped"], 1)
        self.assertEqual(summary["eligible_open_fixflo_jobs"], 2)
        self.assertEqual(summary["newly_confirmed"], 2)
        self.assertEqual(summary["recipient_split"], {"Tenant": 1, "Agent": 1})
        self.assertEqual(
            posts,
            [
                ("IS22870001", "17/07/2026", "Tenant"),
                ("IS22870002", "18/07/2026", "Agent"),
            ],
        )
        self.assertEqual(len(candidates), 2)
        self.assertEqual(results_file["summary"], summary)
        self.assertEqual(saved_state["issues"]["IS22870001"]["confirmed_date"], "17/07/2026")

    def test_deduplicates_by_state_and_existing_comment(self):
        rows = [
            job(job_id=1, planned="2026-07-17", group="Dandara - IS22870001", issue_id="IS22870001"),
            job(job_id=2, planned="2026-07-18", group="Dandara - IS22870002", issue_id="IS22870002"),
        ]
        issues = {
            "IS22870001": issue(issue_id="IS22870001"),
            "IS22870002": issue(issue_id="IS22870002"),
        }
        state = {
            "IS22870001": {
                "issue_id": "IS22870001",
                "confirmed_date": "17/07/2026",
                "recipient": "Agent",
                "comment_id": 11,
                "sent_at": "2026-07-16T08:00:00Z",
                "site_name": "Dandara",
            }
        }
        comments = {
            "IS22870002": [
                {
                    "Id": 12,
                    "Message": MESSAGE_TEMPLATE.format(date="18/07/2026"),
                    "CommentSent": "2026-07-16T09:00:00Z",
                }
            ]
        }

        result, posts, _, _, saved_state = self.run_in_temp(rows, issues, comments, state)

        self.assertEqual(result["summary"]["already_confirmed_same_date"], 2)
        self.assertEqual(result["summary"]["newly_confirmed"], 0)
        self.assertEqual(posts, [])
        self.assertEqual(saved_state["issues"]["IS22870002"]["comment_id"], 12)

    def test_reconfirms_rescheduled_date_and_deduplicates_same_issue_date(self):
        rows = [
            job(job_id=1, planned="2026-07-19", group="Dandara - IS22870001", issue_id="IS22870001"),
            job(job_id=2, planned="2026-07-19", group="Dandara - IS22870001", issue_id="IS22870001"),
        ]
        issues = {"IS22870001": issue(issue_id="IS22870001")}
        state = {
            "IS22870001": {
                "issue_id": "IS22870001",
                "confirmed_date": "17/07/2026",
                "recipient": "Agent",
                "comment_id": 11,
                "sent_at": "2026-07-16T08:00:00Z",
                "site_name": "Dandara",
            }
        }

        result, posts, candidates, _, saved_state = self.run_in_temp(rows, issues, state=state)

        self.assertEqual(result["summary"]["bigchange_jobs_with_is"], 2)
        self.assertEqual(result["summary"]["eligible_open_fixflo_jobs"], 1)
        self.assertEqual(result["summary"]["rescheduled_and_reconfirmed"], 1)
        self.assertEqual(posts, [("IS22870001", "19/07/2026", "Agent")])
        self.assertEqual(len(candidates), 1)
        self.assertIn("BC-1", candidates[0]["bigchange_ref"])
        self.assertIn("BC-2", candidates[0]["bigchange_ref"])
        self.assertEqual(saved_state["issues"]["IS22870001"]["confirmed_date"], "19/07/2026")

    def test_comment_read_failure_blocks_sending(self):
        rows = [job(job_id=1, planned="2026-07-17", group="Dandara - IS22870001", issue_id="IS22870001")]
        issues = {"IS22870001": issue(issue_id="IS22870001")}

        result, posts, _, _, _ = self.run_in_temp(
            rows,
            issues,
            comments={"IS22870001": RuntimeError("unavailable")},
        )

        self.assertEqual(posts, [])
        self.assertEqual(result["summary"]["newly_confirmed"], 0)
        self.assertEqual(result["summary"]["failures"][0]["issue_id"], "IS22870001")

    def test_missing_fixflo_issue_is_skipped_without_failure(self):
        rows = [job(job_id=1, planned="2026-07-17", group="Dandara - IS22870001", issue_id="IS22870001")]
        issues = {"IS22870001": EntityNotFoundError("entity not found")}

        result, posts, candidates, _, _ = self.run_in_temp(rows, issues)

        self.assertEqual(posts, [])
        self.assertEqual(candidates, [])
        self.assertEqual(result["summary"]["fixflo_not_found_skipped"], 1)
        self.assertEqual(result["summary"]["failures"], [])


if __name__ == "__main__":
    unittest.main()
