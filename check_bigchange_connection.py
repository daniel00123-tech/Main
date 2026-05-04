"""Run a safe BigChange connection test.

This script performs a read-only `listmethods` call, which the JobWatch web
service documentation describes as a way to list available service methods.
"""

from __future__ import annotations

import sys

from bigchange_client import (
    BigChangeClient,
    BigChangeConfig,
    BigChangeConfigError,
    format_response_for_display,
    is_success_response,
    load_dotenv,
)


def main() -> int:
    load_dotenv()

    try:
        client = BigChangeClient(BigChangeConfig.from_env())
        result = client.call("listmethods")
    except BigChangeConfigError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        print("Create a .env file using .env.example as a template.", file=sys.stderr)
        return 2
    except RuntimeError as exc:
        print(f"Connection test failed: {exc}", file=sys.stderr)
        return 1

    print("Connection succeeded. BigChange returned:")
    print(format_response_for_display(result))
    return 0 if is_success_response(result) else 1


if __name__ == "__main__":
    raise SystemExit(main())
