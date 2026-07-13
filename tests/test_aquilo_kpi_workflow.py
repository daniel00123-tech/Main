import unittest
from pathlib import Path


WORKFLOW_PATH = Path(".github/workflows/aquilo-bigchange-kpi-overview-report.yml")


class AquiloKpiWorkflowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.workflow_text = WORKFLOW_PATH.read_text(encoding="utf-8")

    def test_workflow_has_daily_schedule_and_name(self) -> None:
        self.assertIn("name: Aquilo BigChange KPI Overview Report", self.workflow_text)
        self.assertIn('cron: "0 7 * * *"', self.workflow_text)
        self.assertIn("workflow_dispatch:", self.workflow_text)

    def test_workflow_runs_kpi_report_with_required_secret_configuration(self) -> None:
        required_secret_env = (
            "BIGCHANGE_BASE_URL",
            "BIGCHANGE_API_KEY",
            "BIGCHANGE_USERNAME",
            "BIGCHANGE_PASSWORD",
            "FRESHDESK_SUBDOMAIN",
            "FRESHDESK_API_KEY",
            "SMTP_HOST",
            "SMTP_PORT",
            "SMTP_USERNAME",
            "SMTP_PASSWORD",
            "SMTP_FROM_EMAIL",
            "SMTP_FROM_NAME",
            "SMTP_TO_EMAIL",
            "SMTP_CC_EMAIL",
        )
        for env_name in required_secret_env:
            with self.subTest(env_name=env_name):
                self.assertIn(f"{env_name}: ${{{{ secrets.{env_name} }}}}", self.workflow_text)
        self.assertIn("BIGCHANGE_AUTH_MODE: api_key", self.workflow_text)
        self.assertIn('FRESHDESK_OPEN_STATUS_IDS: "2,3,8,9"', self.workflow_text)
        self.assertIn("python3 scripts/bigchange_kpi_report.py", self.workflow_text)

    def test_workflow_uploads_only_png_dashboard_artifact(self) -> None:
        self.assertIn("reports/bigchange-kpi-dashboard.png", self.workflow_text)
        self.assertNotIn("reports/bigchange-kpi-dashboard.html\n", self.workflow_text)
        self.assertNotIn("automation-memory/kpi-baseline.json\n          if-no-files-found", self.workflow_text)

    def test_workflow_commits_baseline_snapshot(self) -> None:
        self.assertIn("git add automation-memory/kpi-baseline.json", self.workflow_text)
        self.assertIn('git commit -m "Update Aquilo KPI baseline"', self.workflow_text)


if __name__ == "__main__":
    unittest.main()
