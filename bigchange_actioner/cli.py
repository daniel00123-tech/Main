"""Command line entry point for BigChange completed-job actioning."""

from __future__ import annotations

import argparse
import json
import sys

from .actioner import run_actioner
from .client import BigChangeApiError, BigChangeClient
from .config import ConfigError, load_config


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Action safe completed jobs through the BigChange legacy Web Services API."
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Mark eligible jobs actioned. Without this flag the command performs a dry run.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        config = load_config()
        client = BigChangeClient(config)
        summary = run_actioner(client=client, config=config, execute=args.execute)
    except (ConfigError, BigChangeApiError) as exc:
        print(json.dumps(_error_summary()), file=sys.stdout)
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(summary.to_dict(), sort_keys=True))
    return 1 if summary.failures else 0


def _error_summary() -> dict[str, int]:
    return {
        "jobs_scanned": 0,
        "jobs_actioned": 0,
        "failures": 1,
        "remaining_actionable_jobs": 0,
    }


if __name__ == "__main__":
    raise SystemExit(main())
