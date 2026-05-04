"""Run a BigChange web-service action from the command line.

This is useful while prototyping because it lets us try documented read-only
actions before building more specific automation commands.
"""

from __future__ import annotations

import argparse
import sys

from bigchange_client import (
    BigChangeClient,
    BigChangeConfig,
    BigChangeConfigError,
    format_response_for_display,
    load_dotenv,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a BigChange web-service action")
    parser.add_argument("action", help="BigChange action, for example listmethods")
    parser.add_argument(
        "--param",
        action="append",
        default=[],
        metavar="KEY=VALUE",
        help="Extra query parameter. Can be provided more than once.",
    )
    return parser.parse_args()


def parse_params(raw_params: list[str]) -> dict[str, str]:
    params: dict[str, str] = {}
    for raw_param in raw_params:
        if "=" not in raw_param:
            raise ValueError(f"Expected KEY=VALUE, got {raw_param!r}")
        key, value = raw_param.split("=", 1)
        params[key] = value
    return params


def main() -> int:
    args = parse_args()
    load_dotenv()

    try:
        params = parse_params(args.param)
        client = BigChangeClient(BigChangeConfig.from_env())
        result = client.call(args.action, **params)
    except (BigChangeConfigError, ValueError) as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 2
    except RuntimeError as exc:
        print(f"BigChange action failed: {exc}", file=sys.stderr)
        return 1

    print(format_response_for_display(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
