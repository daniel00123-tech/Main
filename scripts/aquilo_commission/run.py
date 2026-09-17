"""Build and optionally email Aquilo AM commission packs."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from dataclasses import replace
from pathlib import Path
from typing import Any

from .commission import attach_job_commissions
from .engine import build_staff_report, job_id_of
from .jobwatch import (
    AquiloJobWatchClient,
    fetch_finance_history,
    fetch_jobs_history,
    resource_group_map,
)
from .mail import send_preview_email
from .render import build_email_body, build_full_html, pick_quote, qualify_rows
from .settings import (
    COMPANY_NAME,
    HISTORY_ANCHOR,
    LONDON,
    STAFF,
    AquiloSettings,
    ConfigError,
    load_settings,
    report_month,
)
from .util import first_present


def first_name(full_name: str) -> str:
    return full_name.split()[0] if full_name.strip() else full_name


def ensure_jobs_for_documents(
    client: AquiloJobWatchClient,
    jobs: list[dict[str, Any]],
    docs: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    known = {job_id_of(job) for job in jobs}
    known.discard(None)
    missing: list[int] = []
    for doc in docs:
        jid = None
        raw = first_present(doc, ("JobId", "JobID", "LinkedJobId", "LinkedJobID"))
        try:
            jid = int(str(raw).strip()) if raw not in (None, "") else None
        except ValueError:
            jid = None
        if jid and jid not in known:
            missing.append(jid)
            known.add(jid)
    extra: list[dict[str, Any]] = []
    for jid in missing:
        job = client.job(jid)
        if job:
            extra.append(job)
    return jobs + extra


def build_month_packs(
    settings: AquiloSettings,
    *,
    month_start: dt.date,
    month_end: dt.date,
    today: dt.date,
    staff_keys: list[str],
) -> dict[str, dict[str, Any]]:
    client = AquiloJobWatchClient(settings)
    print("fetching Aquilo jobs from", HISTORY_ANCHOR, "to", today, flush=True)
    jobs = fetch_jobs_history(client, today)
    print("jobs", len(jobs), flush=True)
    print("fetching Aquilo finance (end exclusive + gap-fill)", flush=True)
    docs = fetch_finance_history(client, today)
    print("documents", len(docs), flush=True)
    jobs = ensure_jobs_for_documents(client, jobs, docs)
    print("jobs_after_doc_fill", len(jobs), flush=True)
    groups = resource_group_map(client)
    print("resource_map", len(groups), flush=True)

    packs: dict[str, dict[str, Any]] = {}
    month_label = month_start.strftime("%B %Y")
    preview = not settings.go_live
    for key in staff_keys:
        meta = STAFF[key]
        main_rows, anomaly_rows, review_rows = build_staff_report(
            jobs=jobs,
            docs=docs,
            category_id=meta["category_id"],
            month_start=month_start,
            month_end=month_end,
            today=today,
            resource_groups=groups,
        )
        job_rows = attach_job_commissions(main_rows)
        qualification = qualify_rows(job_rows)
        quote = pick_quote()
        full_html = build_full_html(
            staff_name=meta["name"],
            month_label=month_label,
            job_rows=job_rows,
            anomaly_rows=anomaly_rows,
            review_rows=review_rows,
            qualification=qualification,
            preview=preview,
            quote=quote,
        )
        body_html = build_email_body(
            staff_name=meta["name"],
            month_label=month_label,
            first_name=first_name(meta["name"]),
            qualification=qualification,
            job_rows=job_rows,
            anomaly_rows=anomaly_rows,
            review_rows=review_rows,
            preview=preview,
            quote=quote,
        )
        packs[key] = {
            "staff": meta,
            "month_label": month_label,
            "job_rows": job_rows,
            "anomaly_rows": anomaly_rows,
            "review_rows": review_rows,
            "qualification": qualification,
            "full_html": full_html,
            "body_html": body_html,
        }
    return packs


def write_pack(pack: dict[str, Any], out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    staff = pack["staff"]
    month_label = pack["month_label"]
    filename = f"aquilo_{staff['key']}_{month_label.replace(' ', '_').lower()}_commission.html"
    path = out_dir / filename
    path.write_text(pack["full_html"], encoding="utf-8")
    return path


def summarise(pack: dict[str, Any]) -> dict[str, Any]:
    q = pack["qualification"]
    return {
        "staff": pack["staff"]["name"],
        "company": COMPANY_NAME,
        "month": pack["month_label"],
        "rows": len(pack["job_rows"]),
        "anomalies": len(pack["anomaly_rows"]),
        "sale": str(q.total_revenue),
        "po": str(q.total_po),
        "labour": str(q.total_labour),
        "profit": str(q.total_profit),
        "commission_running": str(q.running_commission),
        "commission_payable": str(q.payable_commission),
        "status": q.status,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Aquilo AM commission scorecards (JobWatch read-only)")
    parser.add_argument("--staff", default="all", help="all, or comma-separated isabel,laura,amy")
    parser.add_argument("--year", type=int, default=0)
    parser.add_argument("--month", type=int, default=0)
    parser.add_argument("--send", action="store_true", help="Email preview packs (one per staff)")
    parser.add_argument("--no-cc", action="store_true", help="Send to SMTP_TO_EMAIL only (no Nirvana CC)")
    parser.add_argument("--out-dir", default="reports/aquilo")
    return parser.parse_args(argv)


def selected_staff(raw: str) -> list[str]:
    if raw.strip().lower() in {"", "all"}:
        return list(STAFF)
    keys = []
    for part in raw.split(","):
        key = part.strip().lower()
        if key not in STAFF:
            raise ConfigError(f"Unknown Aquilo staff key {part!r}. Use isabel, laura, amy.")
        keys.append(key)
    return keys


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    settings = load_settings()
    if args.no_cc:
        settings = replace(settings, cc_email="")
    today = dt.datetime.now(LONDON).date()
    if args.year and args.month:
        month_start = dt.date(args.year, args.month, 1)
        if month_start.month == 12:
            month_end = dt.date(month_start.year + 1, 1, 1) - dt.timedelta(days=1)
        else:
            month_end = dt.date(month_start.year, month_start.month + 1, 1) - dt.timedelta(days=1)
    else:
        month_start, month_end = report_month(today)
    if today < HISTORY_ANCHOR:
        raise ConfigError("Report date is before the Aquilo history anchor 2026-01-01")

    staff_keys = selected_staff(args.staff)
    packs = build_month_packs(
        settings,
        month_start=month_start,
        month_end=month_end,
        today=today,
        staff_keys=staff_keys,
    )
    out_dir = Path(args.out_dir)
    summaries = []
    for key in staff_keys:
        pack = packs[key]
        path = write_pack(pack, out_dir)
        summary = summarise(pack)
        summary["html"] = str(path)
        summaries.append(summary)
        if args.send:
            prefix = "PREVIEW " if not settings.go_live else ""
            subject = (
                f"{prefix}{pack['staff']['name']} — {pack['month_label']} — "
                f"{COMPANY_NAME} commission"
            )
            send_preview_email(
                settings=settings,
                subject=subject,
                html_body=pack["body_html"],
                attachment_html=pack["full_html"],
                attachment_name=path.name,
            )
            summary["emailed"] = True
    print(json.dumps({"history_anchor": str(HISTORY_ANCHOR), "packs": summaries}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ConfigError as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        raise SystemExit(2)
