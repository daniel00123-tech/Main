"""Build and optionally email Nirvana account-manager commission packs."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path
from typing import Any

from .commission import attach_job_commissions
from .contracts import ContractEvaluationError
from .engine import build_staff_report, job_id_of
from .jobwatch import (
    JobWatchError,
    NirvanaJobWatchClient,
    fetch_contract_names,
    fetch_finance_history,
    fetch_jobs_history,
    resource_group_map,
)
from .mail import send_report_email
from .render import build_email_body, build_full_html, pick_quote, qualify_rows
from .settings import (
    COMPANY_NAME,
    HISTORY_ANCHOR,
    LONDON,
    STAFF,
    TEST_OVERRIDE_TO,
    ConfigError,
    NirvanaSettings,
    delivery_for,
    load_settings,
    report_month,
)
from .util import as_decimal, first_present, money

D = __import__("decimal").Decimal
ZERO = D("0")


def first_name(full_name: str) -> str:
    return full_name.split()[0] if full_name.strip() else full_name


def ensure_jobs_for_documents(
    client: NirvanaJobWatchClient,
    jobs: list[dict[str, Any]],
    docs: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    known = {job_id_of(job) for job in jobs}
    known.discard(None)
    missing: list[int] = []
    for doc in docs:
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
    settings: NirvanaSettings,
    *,
    month_start: dt.date,
    month_end: dt.date,
    today: dt.date,
    staff_keys: list[str],
) -> dict[str, dict[str, Any]]:
    client = NirvanaJobWatchClient(settings)
    print("fetching Nirvana jobs from", HISTORY_ANCHOR, "to", today, flush=True)
    jobs = fetch_jobs_history(client, today)
    print("jobs", len(jobs), flush=True)
    if not jobs:
        raise JobWatchError("Nirvana JobWatch returned no jobs; refusing to continue")
    print("fetching Nirvana finance (end exclusive + gap-fill)", flush=True)
    docs = fetch_finance_history(client, today)
    print("documents", len(docs), flush=True)
    if not docs:
        raise JobWatchError("Nirvana finance fetch returned no documents; refusing to continue")
    jobs = ensure_jobs_for_documents(client, jobs, docs)
    print("jobs_after_doc_fill", len(jobs), flush=True)
    groups = resource_group_map(client)
    print("resource_map", len(groups), flush=True)
    contract_names = fetch_contract_names(client)
    print("contract_names", len(contract_names), flush=True)

    packs: dict[str, dict[str, Any]] = {}
    month_label = month_start.strftime("%B %Y")
    for key in staff_keys:
        meta = STAFF[key]
        main_rows, anomaly_rows, review_rows, contract_rows = build_staff_report(
            jobs=jobs,
            docs=docs,
            category_id=meta["category_id"],
            month_start=month_start,
            month_end=month_end,
            today=today,
            resource_groups=groups,
        )
        for row in contract_rows:
            name = _contract_label(row, contract_names)
            if name and row.get("reason") == "Explicit BigChange contract":
                row["reason"] = f"Explicit BigChange contract — {name}"
        job_rows = attach_job_commissions(main_rows)
        qualification = qualify_rows(job_rows)
        quote = pick_quote()
        full_html = build_full_html(
            staff_name=meta["name"],
            month_label=month_label,
            job_rows=job_rows,
            anomaly_rows=anomaly_rows,
            review_rows=review_rows,
            contract_rows=contract_rows,
            qualification=qualification,
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
            contract_rows=contract_rows,
            quote=quote,
        )
        packs[key] = {
            "staff": meta,
            "month_label": month_label,
            "job_rows": job_rows,
            "anomaly_rows": anomaly_rows,
            "review_rows": review_rows,
            "contract_rows": contract_rows,
            "qualification": qualification,
            "full_html": full_html,
            "body_html": body_html,
        }
    return packs


def _contract_label(row: dict[str, Any], names: dict[int, str]) -> str:
    for cid in row.get("contract_ids") or []:
        label = names.get(int(cid))
        if label:
            return label
    return ""


def write_pack(pack: dict[str, Any], out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    staff = pack["staff"]
    month_label = pack["month_label"]
    filename = f"nirvana_{staff['key']}_{month_label.replace(' ', '_').lower()}_commission.html"
    path = out_dir / filename
    path.write_text(pack["full_html"], encoding="utf-8")
    return path


def summarise(pack: dict[str, Any]) -> dict[str, Any]:
    q = pack["qualification"]
    excluded_sale = money(sum((as_decimal(row.get("sale")) for row in pack["contract_rows"]), ZERO))
    return {
        "staff": pack["staff"]["name"],
        "company": COMPANY_NAME,
        "month": pack["month_label"],
        "rows": len(pack["job_rows"]),
        "anomalies": len(pack["anomaly_rows"]),
        "contracts_excluded": len(pack["contract_rows"]),
        "sale": str(q.total_revenue),
        "po": str(q.total_po),
        "labour": str(q.total_labour),
        "profit": str(q.total_profit),
        "commission_running": str(q.running_commission),
        "commission_payable": str(q.payable_commission),
        "status": q.status,
        "contract_excluded_sale": str(excluded_sale),
        "contract_excluded_groups": [
            {
                "reference": row.get("reference"),
                "customer_site": row.get("customer_site"),
                "jobs": row.get("job_count"),
                "date_span": row.get("date_span"),
                "invoiced": str(row.get("sale")),
                "reason": row.get("reason"),
            }
            for row in pack["contract_rows"]
        ],
    }


def assert_ready_to_send(settings: NirvanaSettings, staff_keys: list[str], packs: dict[str, dict[str, Any]]) -> None:
    if len(packs) != len(staff_keys):
        raise ConfigError("Refusing to send because a Nirvana report is missing")
    staff_emails = {STAFF[key]["email"].lower() for key in STAFF}
    for key in staff_keys:
        pack = packs[key]
        to_email, cc_email, prefix = delivery_for(settings, pack["staff"])
        body = pack["body_html"]
        if "see attached" in body.lower():
            raise ConfigError("Refusing to send a report that points at an attachment")
        if "Labor" in body:
            raise ConfigError("Refusing to send a report that uses Labor spelling")
        if COMPANY_NAME not in body:
            raise ConfigError("Refusing to send a report that is not branded Nirvana")
        if settings.test_override:
            if to_email.lower() != TEST_OVERRIDE_TO:
                raise ConfigError("Test override recipient check failed")
            if cc_email.strip():
                raise ConfigError("Test override CC check failed")
            if to_email.lower() in staff_emails or (cc_email and cc_email.lower() in staff_emails):
                raise ConfigError("Test override would email a Nirvana account manager")
            if not prefix:
                raise ConfigError("Test override subject prefix is missing")
        else:
            if to_email.lower() != pack["staff"]["email"].lower():
                raise ConfigError(f"Permanent recipient mismatch for {pack['staff']['name']}")
            if cc_email.strip() != settings.cc_email.strip():
                raise ConfigError("Permanent CC does not match NIRVANA_SMTP_CC_EMAIL")
            if prefix:
                raise ConfigError("Permanent routing must not use the test subject prefix")
            if to_email.lower() not in staff_emails:
                raise ConfigError("Permanent routing left the Nirvana staff allowlist")
    if settings.test_override and set(staff_keys) == set(STAFF) and len(packs) != 4:
        raise ConfigError("Test override run of all staff must produce four reports")


def log_pack(pack: dict[str, Any], settings: NirvanaSettings, to_email: str, cc_email: str) -> None:
    q = pack["qualification"]
    payload = {
        "company": COMPANY_NAME,
        "reporting_month": pack["month_label"],
        "account_manager": pack["staff"]["name"],
        "job_category_id": pack["staff"]["category_id"],
        "jobs_included": len(pack["job_rows"]),
        "contract_groups_excluded": len(pack["contract_rows"]),
        "contract_exclusion_reasons": [row.get("reason") for row in pack["contract_rows"]],
        "anomalies": len(pack["anomaly_rows"]),
        "sale": str(q.total_revenue),
        "po": str(q.total_po),
        "labour": str(q.total_labour),
        "profit": str(q.total_profit),
        "running_commission": str(q.running_commission),
        "payable_commission": str(q.payable_commission),
        "status": q.status,
        "actual_to": to_email,
        "actual_cc": cc_email or None,
        "test_override": settings.test_override,
    }
    print(json.dumps(payload), flush=True)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Nirvana AM commission scorecards (JobWatch read-only)")
    parser.add_argument("--staff", default="all", help="all, or comma-separated abi,amy,olivia,hazel")
    parser.add_argument("--year", type=int, default=0)
    parser.add_argument("--month", type=int, default=0)
    parser.add_argument("--send", action="store_true", help="Email one report per selected account manager")
    parser.add_argument("--out-dir", default="reports/nirvana")
    return parser.parse_args(argv)


def selected_staff(raw: str) -> list[str]:
    if raw.strip().lower() in {"", "all"}:
        return list(STAFF)
    keys = []
    for part in raw.split(","):
        key = part.strip().lower()
        if key not in STAFF:
            raise ConfigError(f"Unknown Nirvana staff key {part!r}. Use abi, amy, olivia, hazel.")
        keys.append(key)
    return keys


def subject_for(name: str, month_label: str, prefix: str) -> str:
    return f"{prefix}{name} — {month_label} — {COMPANY_NAME} commission"


def main(argv: list[str] | None = None) -> int:
    try:
        return _run(argv)
    except (ConfigError, JobWatchError, ContractEvaluationError) as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 2


def _run(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    settings = load_settings()
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
        raise ConfigError("Report date is before the Nirvana history anchor 2026-01-01")

    staff_keys = selected_staff(args.staff)
    packs = build_month_packs(
        settings,
        month_start=month_start,
        month_end=month_end,
        today=today,
        staff_keys=staff_keys,
    )
    if args.send:
        assert_ready_to_send(settings, staff_keys, packs)
    out_dir = Path(args.out_dir)
    summaries = []
    for key in staff_keys:
        pack = packs[key]
        path = write_pack(pack, out_dir)
        summary = summarise(pack)
        summary["html"] = str(path)
        to_email, cc_email, prefix = delivery_for(settings, pack["staff"])
        if args.send:
            log_pack(pack, settings, to_email, cc_email)
            sent_to, sent_cc = send_report_email(
                settings=settings,
                staff=pack["staff"],
                subject=subject_for(pack["staff"]["name"], pack["month_label"], prefix),
                html_body=pack["body_html"],
            )
            if sent_to.lower() != to_email.lower() or sent_cc != cc_email:
                raise ConfigError("Email delivery did not match the checked recipients")
            summary["emailed"] = True
            summary["emailed_to"] = sent_to
            summary["emailed_cc"] = sent_cc or None
        summaries.append(summary)
    print(json.dumps({"history_anchor": str(HISTORY_ANCHOR), "packs": summaries}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ConfigError, JobWatchError) as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        raise SystemExit(2)
