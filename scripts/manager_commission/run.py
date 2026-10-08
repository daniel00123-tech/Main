"""Build a manager scorecard. Delivery stays off unless it has been approved."""

from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path
from typing import Any

from .aquilo import build_snapshot as build_aquilo_snapshot
from .aquilo import load_live as load_aquilo_live
from .config import (
    COMPANY,
    ConfigError,
    cc_domain_problem,
    reporting_window,
    target_for,
)
from .mail import send_report, subject_for
from .models import ManagerReport
from .nirvana import build_snapshot as build_nirvana_snapshot
from .nirvana import load_live as load_nirvana_live
from .money import format_margin
from .render import assert_scorecard_html, render_email
from .scorecard import assemble_report


def build_report(
    company: str,
    *,
    year: int = 0,
    month: int = 0,
    today: dt.date | None = None,
    jobs: list[dict[str, Any]] | None = None,
    docs: list[dict[str, Any]] | None = None,
    live: bool = False,
) -> tuple[ManagerReport, str]:
    start, end, as_of = reporting_window(year=year, month=month, today=today)
    target = target_for(company)
    if jobs is not None and docs is not None:
        if target.company_key == "nirvana":
            snapshot = build_nirvana_snapshot(jobs, docs, month_start=start, month_end=end, today=as_of)
        else:
            snapshot = build_aquilo_snapshot(jobs, docs, month_start=start, month_end=end, today=as_of)
    elif live:
        if target.company_key == "nirvana":
            from scripts.nirvana_commission.settings import load_settings

            snapshot = load_nirvana_live(load_settings(), month_start=start, month_end=end, today=as_of)
        else:
            from scripts.aquilo_commission.settings import load_settings

            snapshot = load_aquilo_live(load_settings(), month_start=start, month_end=end, today=as_of)
    else:
        raise ConfigError("Pass job data or request a live read")
    report = assemble_report(target, snapshot, month_start=start, as_of=as_of)
    html = render_email(report, inline_email=False)
    assert_scorecard_html(html)
    return report, html


def audit_payload(report: ManagerReport) -> dict[str, Any]:
    return {
        "period_id": report.period_id,
        "company": report.company_name,
        "manager": report.manager_name,
        "month": report.month_label,
        "period": report.period_label,
        "delivery": report.delivery_mode,
        "email_sent": False,
        "to": report.manager_email,
        "cc": report.cc_email or None,
        "cc_domain_problem": cc_domain_problem(report.cc_email) or None,
        "team_sales": str(report.company_sales),
        "team_gross_profit": str(report.company_profit),
        "margin": format_margin(report.company_margin),
        "qualified": f"{report.qualified_count} of {report.team_size}",
        "running_bonus": str(report.running_bonus),
        "payable_bonus": str(report.payable_bonus),
        "manager_status": report.manager_status,
        "staff": [
            {
                "name": line.name,
                "sales": str(line.sales),
                "profit": str(line.profit),
                "net_running_commission": str(line.net_running_commission),
                "status": line.status,
                "threshold": str(line.profit_gate),
                "manager_contribution": str(line.contribution),
            }
            for line in report.staff_lines
        ],
        "miscellaneous": {
            "sales": str(report.miscellaneous_sales),
            "profit": str(report.miscellaneous_profit),
            "group_ids": report.miscellaneous_group_ids,
        },
        "company_total": {
            "sales": str(report.company_sales),
            "profit": str(report.company_profit),
        },
        "negative_jobs": [
            {
                "owner": row.owner,
                "reference": row.reference,
                "group_id": row.gid,
                "sale": str(row.sale),
                "purchase_orders": str(row.po),
                "labour": str(row.labour),
                "profit": str(row.profit),
                "staff_commission": str(row.staff_commission),
                "manager_impact": str(row.manager_impact),
                "treatment": row.treatment or None,
            }
            for row in report.negative_jobs
        ],
        "attention": [
            {
                "reference": item.reference,
                "group_id": item.gid,
                "owner": item.owner,
                "sales": str(item.sale),
                "profit": None if item.profit is None else str(item.profit),
                "reason": item.reason,
            }
            for item in report.attention
        ],
        "reconciliation": {
            "qualified_staff_net": str(report.reconciliation.qualified_staff_net),
            "unqualified_negative": str(report.reconciliation.unqualified_negative),
            "manager_share": str(report.reconciliation.manager_share),
            "company_profit": str(report.reconciliation.company_profit),
            "required_profit": str(report.reconciliation.required_profit),
            "remaining_profit": str(report.reconciliation.remaining_profit),
            "status": report.reconciliation.status,
            "running_bonus": str(report.reconciliation.running_bonus),
            "payable_bonus": str(report.reconciliation.payable_bonus),
        },
        "priorities": report.priorities,
        "notes": report.notes,
    }


def write_outputs(report: ManagerReport, html: str, out_dir: Path) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = report.period_id.replace(":", "_")
    html_path = out_dir / f"{stem}_manager_scorecard.html"
    audit_path = out_dir / f"{stem}_audit.json"
    html_path.write_text(html, encoding="utf-8")
    audit_path.write_text(json.dumps(audit_payload(report), indent=2), encoding="utf-8")
    return html_path, audit_path


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Grokbot manager commission scorecard (read-only, preview)")
    parser.add_argument("--company", default=COMPANY, help="Nirvana or Aquilo")
    parser.add_argument("--year", type=int, default=0)
    parser.add_argument("--month", type=int, default=0)
    parser.add_argument("--send", action="store_true", help="Email only when delivery has been approved")
    parser.add_argument("--out-dir", default="reports/manager")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    report, html = build_report(args.company, year=args.year, month=args.month, live=True)
    html_path, audit_path = write_outputs(report, html, Path(args.out_dir))
    summary = audit_payload(report)
    summary["html"] = str(html_path)
    summary["audit"] = str(audit_path)
    summary["subject"] = subject_for(report)
    if args.send:
        _send(report, html)
        summary["email_sent"] = True
    else:
        summary["email_sent"] = False
    print(json.dumps(summary, indent=2))
    return 0


def _send(report: ManagerReport, html: str) -> None:
    if report.company_key == "nirvana":
        from scripts.nirvana_commission.settings import load_settings

        settings = load_settings()
        send_report(
            report,
            html,
            smtp_host=settings.smtp_host,
            smtp_port=settings.smtp_port,
            smtp_username=settings.smtp_username,
            smtp_password=settings.smtp_password,
            from_email=settings.from_email,
            from_name=settings.from_name,
        )
        return
    from scripts.aquilo_commission.settings import load_settings

    settings = load_settings()
    send_report(
        report,
        html,
        smtp_host=settings.smtp_host,
        smtp_port=settings.smtp_port,
        smtp_username=settings.smtp_username,
        smtp_password=settings.smtp_password,
        from_email=settings.from_email,
        from_name=settings.from_name,
    )


if __name__ == "__main__":
    raise SystemExit(main())
