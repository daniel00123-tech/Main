from __future__ import annotations

import argparse
import logging
import sys

from .actioner import CompletedJobActioner
from .bigchange import BigChangeClient
from .config import BotConfig, ConfigurationError


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Find completed BigChange jobs that require no further action and "
            "mark them as actioned."
        )
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Apply updates in BigChange. Without this flag the bot runs in dry-run mode.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        help="Maximum number of completed jobs to inspect for this run.",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Logging verbosity.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    logging.basicConfig(level=args.log_level, format="%(levelname)s %(message)s")

    try:
        config = BotConfig.from_env()
    except ConfigurationError as exc:
        parser.error(str(exc))

    client = BigChangeClient(config)
    actioner = CompletedJobActioner(client=client, config=config)

    summary = actioner.run(dry_run=not args.execute, limit=args.limit)
    logging.info(
        "Scanned %s completed jobs; actioned=%s; skipped=%s; dry_run=%s",
        summary.scanned,
        summary.actioned,
        summary.skipped,
        summary.dry_run,
    )
    for decision in summary.decisions:
        logging.info("job_id=%s action=%s reason=%s", decision.job_id, decision.action, decision.reason)
    return 0


if __name__ == "__main__":
    sys.exit(main())
