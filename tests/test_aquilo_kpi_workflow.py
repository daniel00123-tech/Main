import unittest
from pathlib import Path


WORKFLOW_PATH = Path(".github/workflows/aquilo-bigchange-kpi-overview-report.yml")


class AquiloKpiWorkflowTest(unittest.TestCase):
    def test_daily_workflow_contract(self) -> None:
        workflow = WORKFLOW_PATH.read_text(encoding="utf-8")

        self.assertIn("name: Aquilo BigChange KPI Overview Report", workflow)
        self.assertIn('cron: "0 7 * * *"', workflow)
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("python3 scripts/bigchange_kpi_report.py", workflow)
        self.assertIn("browser-actions/setup-chrome@v1", workflow)

    def test_workflow_uses_secrets_and_uploads_only_png(self) -> None:
        workflow = WORKFLOW_PATH.read_text(encoding="utf-8")

        for secret_name in (
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
        ):
            self.assertIn(f"${{{{ secrets.{secret_name} }}}}", workflow)

        self.assertIn("path: reports/bigchange-kpi-dashboard.png", workflow)
        self.assertNotIn("reports/bigchange-kpi-dashboard.html", workflow)
        self.assertNotIn("*.json", workflow)


if __name__ == "__main__":
    unittest.main()
