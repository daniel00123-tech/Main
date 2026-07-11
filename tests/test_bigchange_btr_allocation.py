import base64
import unittest
from unittest.mock import patch

from scripts.bigchange_btr_allocation import BigChangeClient, ConfigError, parse_duration


class DurationParsingTest(unittest.TestCase):
    def test_parses_hms_duration(self) -> None:
        self.assertEqual(parse_duration("01:30:00"), 90)

    def test_parses_numeric_minutes(self) -> None:
        self.assertEqual(parse_duration("75"), 75)


class BigChangeClientAuthTest(unittest.TestCase):
    def test_api_key_mode_does_not_require_basic_credentials(self) -> None:
        with patch.dict(
            "os.environ",
            {
                "BIGCHANGE_AUTH_MODE": "api_key",
                "BIGCHANGE_API_KEY": "test-key",
            },
            clear=True,
        ):
            client = BigChangeClient()

        self.assertEqual(client.headers["key"], "test-key")
        self.assertNotIn("Authorization", client.headers)

    def test_api_key_mode_adds_basic_auth_when_credentials_are_available(self) -> None:
        with patch.dict(
            "os.environ",
            {
                "BIGCHANGE_AUTH_MODE": "api_key",
                "BIGCHANGE_API_KEY": "test-key",
                "BIGCHANGE_USERNAME": "user@example.com",
                "BIGCHANGE_PASSWORD": "secret",
            },
            clear=True,
        ):
            client = BigChangeClient()

        expected = base64.b64encode(b"user@example.com:secret").decode("ascii")
        self.assertEqual(client.headers["Authorization"], f"Basic {expected}")

    def test_basic_mode_requires_username_password(self) -> None:
        with patch.dict("os.environ", {"BIGCHANGE_API_KEY": "test-key"}, clear=True):
            with self.assertRaises(ConfigError):
                BigChangeClient()


if __name__ == "__main__":
    unittest.main()
