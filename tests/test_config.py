from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

from bigchange_actioner.config import ConfigError, load_config


class ConfigTests(unittest.TestCase):
    def test_loads_explicit_env_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / "bigchange.env"
            env_file.write_text(
                "\n".join(
                    [
                        "BIGCHANGE_AUTH_MODE=api_key",
                        "BIGCHANGE_API_KEY=file-key",
                        "BIGCHANGE_USERNAME=file-user",
                        "BIGCHANGE_PASSWORD=file-pass",
                        "BIGCHANGE_LOOKBACK_DAYS=30",
                        "BIGCHANGE_COMPLETED_STATUSES=Completed,Completed with issues",
                        "BIGCHANGE_ACTION_RESULT_VALUES=Complete,Completed",
                    ]
                ),
                encoding="utf-8",
            )

            config = load_config({"BIGCHANGE_ENV_FILE": str(env_file)})

        self.assertEqual(config.api_key, "file-key")
        self.assertEqual(config.username, "file-user")
        self.assertEqual(config.password, "file-pass")
        self.assertEqual(config.lookback_days, 30)
        self.assertEqual(config.completed_statuses, ("Completed", "Completed with issues"))
        self.assertEqual(config.action_result_values, ("Complete", "Completed"))

    def test_process_environment_overrides_env_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / "bigchange.env"
            env_file.write_text(
                "\n".join(
                    [
                        "BIGCHANGE_API_KEY=file-key",
                        "BIGCHANGE_USERNAME=file-user",
                        "BIGCHANGE_PASSWORD=file-pass",
                    ]
                ),
                encoding="utf-8",
            )

            config = load_config(
                {
                    "BIGCHANGE_ENV_FILE": str(env_file),
                    "BIGCHANGE_API_KEY": "env-key",
                    "BIGCHANGE_USERNAME": "env-user",
                    "BIGCHANGE_PASSWORD": "env-pass",
                }
            )

        self.assertEqual(config.api_key, "env-key")
        self.assertEqual(config.username, "env-user")
        self.assertEqual(config.password, "env-pass")

    def test_requires_api_key_credentials(self) -> None:
        with self.assertRaises(ConfigError):
            load_config({})

    def test_rejects_unsupported_auth_mode(self) -> None:
        with self.assertRaises(ConfigError):
            load_config(
                {
                    "BIGCHANGE_AUTH_MODE": "oauth",
                    "BIGCHANGE_API_KEY": "key",
                    "BIGCHANGE_USERNAME": "user",
                    "BIGCHANGE_PASSWORD": "pass",
                }
            )


if __name__ == "__main__":
    unittest.main()
