from __future__ import annotations

import pytest

import bigchange_actioner.config as config_module
from bigchange_actioner.bigchange import BigChangeClient
from bigchange_actioner.config import BotConfig, ConfigurationError


def test_api_key_mode_loads_login_credentials_from_environment() -> None:
    config = BotConfig.from_env(
        {
            "BIGCHANGE_BASE_URL": "https://webservice.bigchange.com/v01/services.ashx",
            "BIGCHANGE_API_KEY": "company-api-key",
            "BIGCHANGE_USERNAME": "user@example.test",
            "BIGCHANGE_PASSWORD": "password",
        }
    )

    assert config.auth_mode == "api_key"
    assert config.api_key == "company-api-key"
    assert config.username == "user@example.test"
    assert config.password == "password"
    assert config.client_id is None
    assert config.client_secret is None
    assert config.lookback_days == 14
    assert config.completed_statuses == ("Completed", "Completed with issues")
    assert config.action_result_field == "StatusComment"
    assert config.action_result_values == ("Complete", "Completed")


def test_oauth_mode_requires_client_credentials() -> None:
    with pytest.raises(ConfigurationError, match="BIGCHANGE_CLIENT_ID is required"):
        BotConfig.from_env(
            {
                "BIGCHANGE_AUTH_MODE": "oauth",
                "BIGCHANGE_BASE_URL": "https://api.example.test/v1",
            }
        )


def test_api_key_mode_requires_api_key_username_and_password() -> None:
    with pytest.raises(ConfigurationError, match="BIGCHANGE_API_KEY is required"):
        BotConfig.from_env(
            {
                "BIGCHANGE_BASE_URL": "https://webservice.bigchange.com/v01/services.ashx",
                "BIGCHANGE_AUTH_MODE": "api_key",
            }
        )

    with pytest.raises(ConfigurationError, match="BIGCHANGE_USERNAME is required"):
        BotConfig.from_env(
            {
                "BIGCHANGE_BASE_URL": "https://webservice.bigchange.com/v01/services.ashx",
                "BIGCHANGE_AUTH_MODE": "api_key",
                "BIGCHANGE_API_KEY": "company-api-key",
            }
        )

    with pytest.raises(ConfigurationError, match="BIGCHANGE_PASSWORD is required"):
        BotConfig.from_env(
            {
                "BIGCHANGE_BASE_URL": "https://webservice.bigchange.com/v01/services.ashx",
                "BIGCHANGE_AUTH_MODE": "api_key",
                "BIGCHANGE_API_KEY": "company-api-key",
                "BIGCHANGE_USERNAME": "user@example.test",
            }
        )


def test_api_key_mode_builds_basic_auth_and_key_headers() -> None:
    config = BotConfig.from_env(
        {
            "BIGCHANGE_BASE_URL": "https://webservice.bigchange.com/v01/services.ashx",
            "BIGCHANGE_API_KEY": "company-api-key",
            "BIGCHANGE_USERNAME": "user@example.test",
            "BIGCHANGE_PASSWORD": "password",
        }
    )

    headers = BigChangeClient(config)._auth_headers()

    assert headers["Authorization"] == "Basic dXNlckBleGFtcGxlLnRlc3Q6cGFzc3dvcmQ="
    assert headers["key"] == "company-api-key"
    assert "customer-id" not in headers


def test_dotenv_values_are_loaded_without_overriding_environment(tmp_path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    for name in (
        "BIGCHANGE_AUTH_MODE",
        "BIGCHANGE_BASE_URL",
        "BIGCHANGE_API_KEY",
        "BIGCHANGE_USERNAME",
        "BIGCHANGE_PASSWORD",
    ):
        monkeypatch.delenv(name, raising=False)
    (tmp_path / ".env").write_text(
        "\n".join(
            [
                "BIGCHANGE_AUTH_MODE=api_key",
                "BIGCHANGE_BASE_URL=https://webservice.example.test/v01/services.ashx",
                "BIGCHANGE_API_KEY=dotenv-key",
                "BIGCHANGE_USERNAME=dotenv-user@example.test",
                "BIGCHANGE_PASSWORD=dotenv-password",
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("BIGCHANGE_API_KEY", "environment-key")

    values = config_module._env_with_dotenv()

    assert values["BIGCHANGE_API_KEY"] == "environment-key"
    assert values["BIGCHANGE_USERNAME"] == "dotenv-user@example.test"


def test_explicit_env_file_is_loaded(tmp_path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    secret_file = tmp_path / "bigchange.env"
    secret_file.write_text(
        "\n".join(
            [
                "BIGCHANGE_AUTH_MODE=api_key",
                "BIGCHANGE_BASE_URL=https://webservice.example.test/v01/services.ashx",
                "BIGCHANGE_API_KEY=file-key",
                "BIGCHANGE_USERNAME=file-user@example.test",
                "BIGCHANGE_PASSWORD=file-password",
            ]
        ),
        encoding="utf-8",
    )
    for name in (
        "BIGCHANGE_AUTH_MODE",
        "BIGCHANGE_BASE_URL",
        "BIGCHANGE_API_KEY",
        "BIGCHANGE_USERNAME",
        "BIGCHANGE_PASSWORD",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("BIGCHANGE_ENV_FILE", str(secret_file))

    config = BotConfig.from_env()

    assert config.api_key == "file-key"
    assert config.username == "file-user@example.test"
