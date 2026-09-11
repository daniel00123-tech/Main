from __future__ import annotations

import json
import unittest
from unittest.mock import patch
from urllib import parse

from bigchange_actioner.client import BigChangeApiError, BigChangeClient
from tests.test_actioner import make_config


class FakeResponse:
    def __init__(self, payload: dict[str, object]) -> None:
        self.payload = payload

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def read(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")


class ClientTests(unittest.TestCase):
    def test_jobs_list_uses_legacy_query_params_and_headers(self) -> None:
        config = make_config()
        captured: dict[str, object] = {}

        def fake_urlopen(req: object, timeout: float) -> FakeResponse:
            captured["url"] = req.full_url
            captured["authorization"] = req.get_header("Authorization")
            captured["key"] = req.get_header("Key")
            captured["timeout"] = timeout
            return FakeResponse({"Code": 0, "Result": "No results"})

        with patch("bigchange_actioner.client.request.urlopen", fake_urlopen):
            jobs = BigChangeClient(config, timeout=12.0).list_jobs(
                start="2026-05-01",
                end="2026-05-16",
                page=0,
                page_size=500,
            )

        self.assertEqual(jobs, [])
        self.assertEqual(captured["timeout"], 12.0)
        self.assertTrue(str(captured["authorization"]).startswith("Basic "))
        self.assertEqual(captured["key"], "api-key")
        query = dict(parse.parse_qsl(parse.urlsplit(str(captured["url"])).query))
        self.assertEqual(query["action"], "JobsList")
        self.assertEqual(query["Start"], "2026-05-01")
        self.assertEqual(query["End"], "2026-05-16")
        self.assertEqual(query["Page"], "0")
        self.assertEqual(query["PageSize"], "500")
        self.assertEqual(query["IncludeCustomFields"], "true")
        self.assertEqual(query["Unactioned"], "1")

    def test_api_error_code_raises_without_exposing_credentials(self) -> None:
        config = make_config()

        with patch(
            "bigchange_actioner.client.request.urlopen",
            return_value=FakeResponse({"Code": 2, "Result": "Missing Parameters"}),
        ):
            with self.assertRaises(BigChangeApiError) as context:
                BigChangeClient(config).list_jobs(
                    start="2026-05-01",
                    end="2026-05-16",
                    page=0,
                    page_size=500,
                )

        message = str(context.exception)
        self.assertIn("Missing Parameters", message)
        self.assertNotIn("api-key", message)
        self.assertNotIn("user", message)
        self.assertNotIn("pass", message)


if __name__ == "__main__":
    unittest.main()
