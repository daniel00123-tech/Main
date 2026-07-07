import re
import unittest
from pathlib import Path


WORKFLOW_PATH = Path(".github/workflows/aquilo-bigchange-kpi-overview-report.yml")


class AquiloBigChangeKpiWorkflowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.workflow = WORKFLOW_PATH.read_text(encoding="utf-8")

    def test_daily_workflow_exists_with_expected_schedule_and_entrypoint(self) -> None:
        self.assertTrue(WORKFLOW_PATH.exists())
        self.assertIn("name: Aquilo BigChange KPI Overview Report", self.workflow)
        self.assertRegex(self.workflow, r"cron:\s+[\"']0 7 \* \* \*[\"']")
        self.assertIn("workflow_dispatch:", self.workflow)
        self.assertIn("python3 scripts/bigchange_kpi_report.py", self.workflow)

    def test_runtime_configuration_uses_repository_secrets(self) -> None:
        for secret_name in (
            "BIGCHANGE_API_KEY",
            "BIGCHANGE_USERNAME",
            "BIGCHANGE_PASSWORD",
            "FRESHDESK_API_KEY",
            "SMTP_USERNAME",
            "SMTP_PASSWORD",
            "SMTP_FROM_EMAIL",
            "SMTP_TO_EMAIL",
            "SMTP_CC_EMAIL",
        ):
            self.assertIn(f"${{{{ secrets.{secret_name} }}}}", self.workflow)

        self.assertIn("BIGCHANGE_AUTH_MODE: api_key", self.workflow)
        self.assertIn("BIGCHANGE_BASE_URL: https://webservice.bigchange.com/v01/services.ashx", self.workflow)
        self.assertIn("FRESHDESK_SUBDOMAIN: nirvanamaintenance.freshdesk.com", self.workflow)
        self.assertIn("SMTP_HOST: smtp.gmail.com", self.workflow)
        self.assertIn('SMTP_PORT: "587"', self.workflow)

    def test_uploads_only_dashboard_png_artifact(self) -> None:
        artifact_paths = re.findall(r"(?m)^\s+path:\s+(.+)$", self.workflow)

        self.assertEqual(artifact_paths, ["reports/bigchange-kpi-dashboard.png"])
        self.assertNotRegex(self.workflow, r"(?m)^\s+path:\s+.*\.html\b")
        self.assertNotRegex(self.workflow, r"(?m)^\s+path:\s+.*\.json\b")


if __name__ == "__main__":
    unittest.main()
