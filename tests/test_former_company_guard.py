import os
import unittest
from unittest.mock import patch

from scripts.former_company_guard import (
    FormerCompanyAccessError,
    describe_former_company_hit,
    is_sensitive_env_name,
    reject_former_company_environment,
    reject_former_company_value,
)


class FormerCompanyGuardTest(unittest.TestCase):
    def test_detects_former_company_markers_without_exposing_values(self) -> None:
        self.assertEqual(describe_former_company_hit("https://aquilo.freshdesk.com"), "aquilo")
        self.assertEqual(describe_former_company_hit("user@nirvana-group.co.uk"), "nirvana-group.co.uk")
        self.assertEqual(describe_former_company_hit("Urban Maintenance Ops"), "urban maintenance")
        self.assertIsNone(describe_former_company_hit("https://caddington.example.com"))
        self.assertIsNone(describe_former_company_hit("ht-business-mcp.example.workers.dev"))

    def test_rejects_former_company_credentials_and_destinations(self) -> None:
        with self.assertRaises(FormerCompanyAccessError) as caught:
            reject_former_company_value("SMTP_TO_EMAIL", "ops@nirvana-maintenance.co.uk")
        self.assertNotIn("ops@", str(caught.exception))
        self.assertIn("SMTP_TO_EMAIL", str(caught.exception))

        with self.assertRaises(FormerCompanyAccessError):
            reject_former_company_value("FRESHDESK_SUBDOMAIN", "aquilo.freshdesk.com")

        with self.assertRaises(FormerCompanyAccessError):
            reject_former_company_value("AQUILO_API_KEY", "not-a-real-secret")

    def test_allows_current_business_and_unrelated_config(self) -> None:
        reject_former_company_value("SMTP_TO_EMAIL", "reports@caddington.example")
        reject_former_company_value("CLOUDFLARE_API_TOKEN", "not-a-real-token")
        reject_former_company_value(
            "BIGCHANGE_BASE_URL", "https://webservice.bigchange.com/v01/services.ashx"
        )

    def test_scans_runtime_environment_and_ignores_unrelated_vars(self) -> None:
        self.assertTrue(is_sensitive_env_name("SMTP_CC_EMAIL"))
        self.assertTrue(is_sensitive_env_name("FIXFLO_API_KEY"))
        self.assertTrue(is_sensitive_env_name("CLOUDFLARE_API_TOKEN"))
        self.assertFalse(is_sensitive_env_name("PATH"))

        reject_former_company_environment(
            {
                "PATH": "/usr/bin",
                "CLOUDFLARE_API_TOKEN": "not-a-real-token",
                "BIGCHANGE_BASE_URL": "https://webservice.bigchange.com/v01/services.ashx",
            }
        )
        with self.assertRaises(FormerCompanyAccessError):
            reject_former_company_environment({"BIGCHANGE_USERNAME": "daniel@nirvana-group.co.uk"})

    def test_optional_empty_values_are_ignored(self) -> None:
        reject_former_company_value("SMTP_CC_EMAIL", "")
        reject_former_company_value("SMTP_CC_EMAIL", None)


class GuardedScriptEnvTest(unittest.TestCase):
    def test_kpi_required_env_blocks_former_company_smtp(self) -> None:
        from scripts.bigchange_kpi_report import ConfigError, required_env

        with patch.dict(os.environ, {"SMTP_TO_EMAIL": "team@aquilo.example"}, clear=False):
            with self.assertRaises(ConfigError):
                required_env("SMTP_TO_EMAIL")


if __name__ == "__main__":
    unittest.main()
