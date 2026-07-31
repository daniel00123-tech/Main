import unittest
from pathlib import Path


class AquiloBigChangeWorkflowTest(unittest.TestCase):
    def test_daily_kpi_workflow_contract(self) -> None:
        workflow_path = Path(".github/workflows/aquilo-bigchange-kpi-overview-report.yml")
        workflow = workflow_path.read_text(encoding="utf-8")

        self.assertIn("name: Aquilo BigChange KPI Overview Report", workflow)
        self.assertIn('cron: "0 7 * * *"', workflow)
        self.assertIn("python3 scripts/bigchange_kpi_report.py", workflow)
        self.assertIn("reports/bigchange-kpi-dashboard.png", workflow)
        self.assertIn("automation-memory/kpi-baseline.json", workflow)
        self.assertNotIn("reports/bigchange-kpi-dashboard.html", workflow)


if __name__ == "__main__":
    unittest.main()
