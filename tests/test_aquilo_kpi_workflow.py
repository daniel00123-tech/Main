from pathlib import Path
import unittest


WORKFLOW_PATH = Path(".github/workflows/aquilo-bigchange-kpi-overview-report.yml")


class AquiloKpiWorkflowTest(unittest.TestCase):
    def test_daily_kpi_workflow_is_scheduled_for_0700_utc(self) -> None:
        workflow = WORKFLOW_PATH.read_text(encoding="utf-8")

        self.assertIn("name: Aquilo BigChange KPI Overview Report", workflow)
        self.assertIn('cron: "0 7 * * *"', workflow)
        self.assertIn("workflow_dispatch:", workflow)

    def test_daily_kpi_workflow_runs_report_with_required_configuration(self) -> None:
        workflow = WORKFLOW_PATH.read_text(encoding="utf-8")

        self.assertIn("python3 scripts/bigchange_kpi_report.py", workflow)
        for env_name in (
            "BIGCHANGE_AUTH_MODE",
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
        ):
            self.assertIn(f"{env_name}:", workflow)

    def test_daily_kpi_workflow_uploads_only_dashboard_png_artifact(self) -> None:
        workflow = WORKFLOW_PATH.read_text(encoding="utf-8")

        self.assertIn("path: reports/bigchange-kpi-dashboard.png", workflow)
        self.assertNotIn("path: reports/bigchange-kpi-dashboard.html", workflow)
        self.assertNotIn("path: automation-memory/kpi-baseline.json", workflow)


if __name__ == "__main__":
    unittest.main()
