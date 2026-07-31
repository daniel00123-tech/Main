import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "aquilo-bigchange-kpi-overview-report.yml"


class AquiloKpiWorkflowTest(unittest.TestCase):
    def test_daily_workflow_contract(self) -> None:
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("name: Aquilo BigChange KPI Overview Report", text)
        self.assertIn('- cron: "0 7 * * *"', text)
        self.assertIn("run: python3 scripts/bigchange_kpi_report.py", text)
        self.assertIn("BIGCHANGE_AUTH_MODE: api_key", text)
        self.assertIn("BIGCHANGE_BASE_URL: https://webservice.bigchange.com/v01/services.ashx", text)
        self.assertIn("FRESHDESK_SUBDOMAIN: nirvanamaintenance.freshdesk.com", text)
        self.assertIn("SMTP_HOST: smtp.gmail.com", text)
        self.assertIn("git add automation-memory/kpi-baseline.json", text)

    def test_uploads_only_dashboard_png_artifact(self) -> None:
        text = WORKFLOW.read_text(encoding="utf-8")
        artifact_match = re.search(
            r"uses: actions/upload-artifact@v4\s+with:\s+name: aquilo-bigchange-kpi-dashboard\s+path: ([^\n]+)",
            text,
        )

        self.assertIsNotNone(artifact_match)
        self.assertEqual(artifact_match.group(1).strip(), "reports/bigchange-kpi-dashboard.png")
        self.assertNotRegex(text, r"path: .*\.html")
        self.assertNotRegex(text, r"path: .*\.json")


if __name__ == "__main__":
    unittest.main()
