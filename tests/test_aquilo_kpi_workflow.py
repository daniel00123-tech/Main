import re
import unittest
from pathlib import Path


WORKFLOW_PATH = Path(".github/workflows/aquilo-bigchange-kpi-overview-report.yml")


class AquiloKpiWorkflowTest(unittest.TestCase):
    def test_daily_kpi_workflow_contract(self) -> None:
        self.assertTrue(WORKFLOW_PATH.exists(), "daily KPI workflow is missing")
        text = WORKFLOW_PATH.read_text(encoding="utf-8")

        self.assertIn("name: Aquilo BigChange KPI Overview Report", text)
        self.assertRegex(text, r'cron:\s+"0 7 \* \* \*"')
        self.assertIn("python3 scripts/bigchange_kpi_report.py", text)
        self.assertIn("BIGCHANGE_AUTH_MODE: api_key", text)

        required_secret_names = [
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
        ]
        for secret_name in required_secret_names:
            with self.subTest(secret_name=secret_name):
                self.assertIn(f"{secret_name}: ${{{{ secrets.{secret_name} }}}}", text)

    def test_workflow_uploads_only_dashboard_png_and_commits_baseline(self) -> None:
        text = WORKFLOW_PATH.read_text(encoding="utf-8")

        upload_section = re.search(r"- name: Upload dashboard PNG(?P<section>.*?)(?:\n\n      - name:|\Z)", text, re.S)
        self.assertIsNotNone(upload_section)
        section = upload_section.group("section")
        self.assertIn("path: reports/bigchange-kpi-dashboard.png", section)
        self.assertNotRegex(section, r"\.html\b|\.json\b")

        self.assertIn("git add automation-memory/kpi-baseline.json", text)


if __name__ == "__main__":
    unittest.main()
