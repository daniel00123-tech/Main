from __future__ import annotations

import pytest

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
