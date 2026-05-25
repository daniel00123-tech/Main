#!/usr/bin/env python3
"""Generate and email a May 2026 BigChange completed KPI movement report."""

from __future__ import annotations

import concurrent.futures
import datetime as dt
import html
import json
import os
import re
import smtplib
import subprocess
import sys
import tempfile
from collections import defaultdict
from email import encoders
from email.mime.base import MIMEBase
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from typing import Any

try:
    from bigchange_kpi_report import (
        BigChangeClient,
        COMPLETED_STATUS_IDS,
        DECIMAL_ZERO,
        OPEN_NOT_STARTED_STATUS_IDS,
        SALES_ORDER_TYPES,
        UNALLOCATED_STATUS_IDS,
        as_int,
        calculate_sales,
        clean_name,
        document_job_id,
        first_present,
        format_currency,
        is_populated,
        job_category_name,
        mailbox_address,
        match_staff_name,
        name_key,
        optional_env,
        parse_date,
        required_env,
        should_exclude_category,
    )
except ImportError:  # pragma: no cover - used when imported as scripts.*
    from scripts.bigchange_kpi_report import (
        BigChangeClient,
        COMPLETED_STATUS_IDS,
        DECIMAL_ZERO,
        OPEN_NOT_STARTED_STATUS_IDS,
        SALES_ORDER_TYPES,
        UNALLOCATED_STATUS_IDS,
        as_int,
        calculate_sales,
        clean_name,
        document_job_id,
        first_present,
        format_currency,
        is_populated,
        job_category_name,
        mailbox_address,
        match_staff_name,
        name_key,
        optional_env,
        parse_date,
        required_env,
        should_exclude_category,
    )


REPORT_START = dt.date(2026, 5, 1)
REPORT_END = dt.date(2026, 5, 31)
REPORT_END_EXCLUSIVE = REPORT_END + dt.timedelta(days=1)
JOB_CARD_SENT_STATUS_ID = 30
INVOICE_CREATED_STATUS_ID = 34
SCHEDULED_STATUS_ID = 2
MOVEMENT_ORDER = [
    ("actioned_jobs", "Jobs actioned"),
    ("invoiced_jobs", "Jobs invoiced"),
    ("scheduled_from_unallocated_jobs", "Unallocated to scheduled"),
    ("historic_completed_jobs", "Historic to completed"),
]


def in_report_period(value: dt.datetime | None) -> bool:
    return value is not None and REPORT_START <= value.date() <= REPORT_END


def job_id(row: dict[str, Any]) -> str:
    return clean_name(first_present(row, ("JobId", "JobID", "Id", "JobStatusJobId")))


def client_activity_status_id(row: dict[str, Any]) -> int | None:
    return as_int(first_present(row, ("JobClientStatusID", "JobClientStatusId")))


def job_status_id(row: dict[str, Any]) -> int | None:
    return as_int(first_present(row, ("JobStatusID", "JobStatusId", "StatusId")))


def job_status_date(row: dict[str, Any]) -> dt.datetime | None:
    return parse_date(first_present(row, ("JobStatusDate", "StatusDate")))


def client_activity_date(row: dict[str, Any]) -> dt.datetime | None:
    return parse_date(first_present(row, ("JobClientStatusDate", "ClientStatusDate")))


def activity_owner(row: dict[str, Any]) -> str:
    return clean_name(first_present(row, ("JobClientStatusOwner", "Owner", "CreatedBy")))


def status_owner(row: dict[str, Any]) -> str:
    return clean_name(first_present(row, ("JobStatusOwner", "Owner", "CreatedBy")))


def staff_names_from_categories(client: BigChangeClient) -> set[str]:
    staff_names: set[str] = set()
    for category in client.categories():
        name = clean_name(first_present(category, ("label", "JobCategoryName", "CategoryName", "Name")))
        if not should_exclude_category(name):
            staff_names.add(name)
    return staff_names


def matched_staff(owner: str, staff_by_key: dict[str, str]) -> str | None:
    return match_staff_name(owner, staff_by_key) if owner else None


def add_unique_count(
    counters: dict[str, dict[str, set[str]]],
    metric: str,
    staff: str | None,
    identifier: str,
) -> None:
    if staff and identifier:
        counters[staff][metric].add(identifier)


def latest_matching_activity(
    rows: list[dict[str, Any]],
    status_id: int,
) -> dict[str, Any] | None:
    matches = [
        row
        for row in rows
        if client_activity_status_id(row) == status_id and in_report_period(client_activity_date(row))
    ]
    if not matches:
        return None
    matches.sort(key=lambda row: client_activity_date(row) or dt.datetime.min, reverse=True)
    return matches[0]


def scheduled_from_unallocated_event(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    ordered = sorted(rows, key=lambda row: job_status_date(row) or dt.datetime.min)
    previous_status: int | None = None
    matches: list[dict[str, Any]] = []
    for row in ordered:
        current_status = job_status_id(row)
        if current_status == SCHEDULED_STATUS_ID and previous_status in UNALLOCATED_STATUS_IDS and in_report_period(job_status_date(row)):
            matches.append(row)
        if current_status is not None:
            previous_status = current_status
    if not matches:
        return None
    matches.sort(key=lambda row: job_status_date(row) or dt.datetime.min, reverse=True)
    return matches[0]


def historic_completed_event(job: dict[str, Any], rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    planned_start = parse_date(first_present(job, ("PlannedStart", "ScheduledStart")))
    if planned_start is None:
        return None
    matches = [
        row
        for row in rows
        if job_status_id(row) in COMPLETED_STATUS_IDS
        and in_report_period(job_status_date(row))
        and planned_start.date() < (job_status_date(row) or dt.datetime.max).date()
    ]
    if not matches:
        return None
    matches.sort(key=lambda row: job_status_date(row) or dt.datetime.min, reverse=True)
    return matches[0]


def fetch_histories(client: BigChangeClient, ids: set[str]) -> dict[str, list[dict[str, Any]]]:
    histories: dict[str, list[dict[str, Any]]] = {}
    if not ids:
        return histories
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(client.job_status_history, identifier): identifier for identifier in ids}
        for future in concurrent.futures.as_completed(futures):
            identifier = futures[future]
            try:
                histories[identifier] = future.result()
            except Exception:
                histories[identifier] = []
    return histories


def fetch_customer_activities(client: BigChangeClient, ids: set[str]) -> dict[str, list[dict[str, Any]]]:
    activities: dict[str, list[dict[str, Any]]] = {}
    if not ids:
        return activities
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(client.job_customer_activity, identifier): identifier for identifier in ids}
        for future in concurrent.futures.as_completed(futures):
            identifier = futures[future]
            try:
                activities[identifier] = future.result()
            except Exception:
                activities[identifier] = []
    return activities


def jobs_by_id(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        identifier = job_id(row)
        if identifier and identifier not in result:
            result[identifier] = row
    return result


def completed_jobs_in_period(client: BigChangeClient) -> dict[str, dict[str, Any]]:
    completed_statuses = "|".join(str(status) for status in sorted(COMPLETED_STATUS_IDS))
    rows = client.jobslist(
        {
            "Start": REPORT_START.isoformat(),
            "End": REPORT_END_EXCLUSIVE.isoformat(),
            "DateOptionId": 4,
            "StatusId": completed_statuses,
        }
    )
    return jobs_by_id(
        [
            row
            for row in rows
            if as_int(first_present(row, ("StatusId", "JobStatusID"))) in COMPLETED_STATUS_IDS
            and in_report_period(parse_date(first_present(row, ("StatusDate", "JobStatusDate"))))
        ]
    )


def status_source_jobs(client: BigChangeClient, completed_jobs: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    active_statuses = "|".join(
        str(status) for status in sorted(OPEN_NOT_STARTED_STATUS_IDS | COMPLETED_STATUS_IDS | {SCHEDULED_STATUS_ID})
    )
    batches: list[list[dict[str, Any]]] = [
        list(completed_jobs.values()),
        client.jobslist(
            {
                "Start": REPORT_START.isoformat(),
                "End": REPORT_END_EXCLUSIVE.isoformat(),
                "DateOptionId": 0,
                "StatusId": active_statuses,
            }
        ),
        client.jobslist(
            {
                "Start": REPORT_START.isoformat(),
                "End": REPORT_END_EXCLUSIVE.isoformat(),
                "DateOptionId": 4,
                "StatusId": active_statuses,
            }
        ),
    ]
    merged: dict[str, dict[str, Any]] = {}
    for batch in batches:
        merged.update(jobs_by_id(batch))
    return merged


def eligible_invoice_documents(financial_documents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    eligible: list[dict[str, Any]] = []
    for document in financial_documents:
        order_type = re.sub(
            r"[^a-z]",
            "",
            clean_name(first_present(document, ("OrderType", "DocumentType", "DocType"))).lower(),
        )
        if order_type not in SALES_ORDER_TYPES:
            continue
        if any(
            is_populated(first_present(document, names))
            for names in (
                ("CancellationDate", "CancelledDate", "Cancelled"),
                ("DeletionDate", "DeletedDate", "Deleted"),
                ("RejectionDate", "RejectedDate", "Rejected"),
            )
        ):
            continue
        if document_job_id(document):
            eligible.append(document)
    return eligible


def build_completed_report(client: BigChangeClient) -> dict[str, Any]:
    now = dt.datetime.now(dt.timezone.utc)
    staff_names = staff_names_from_categories(client)
    staff_by_key = {name_key(name): name for name in staff_names if name_key(name)}
    completed_jobs = completed_jobs_in_period(client)
    completed_jobs = {
        identifier: row
        for identifier, row in completed_jobs.items()
        if not should_exclude_category(job_category_name(row))
    }
    status_jobs = status_source_jobs(client, completed_jobs)
    status_jobs = {
        identifier: row
        for identifier, row in status_jobs.items()
        if not should_exclude_category(job_category_name(row))
    }
    financial_documents = client.invoices_with_items_by_period(REPORT_START, REPORT_END)
    invoice_documents = eligible_invoice_documents(financial_documents)
    invoice_job_ids = {document_job_id(document) for document in invoice_documents if document_job_id(document)}
    activity_job_ids = set(completed_jobs) | invoice_job_ids
    histories = fetch_histories(client, set(status_jobs))
    activities = fetch_customer_activities(client, activity_job_ids)

    counters: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    sales: dict[str, float] = defaultdict(float)

    for identifier, row in completed_jobs.items():
        activity_rows = activities.get(identifier, [])

        actioned = latest_matching_activity(activity_rows, JOB_CARD_SENT_STATUS_ID)
        if actioned:
            add_unique_count(
                counters,
                "actioned_jobs",
                matched_staff(activity_owner(actioned), staff_by_key) or job_category_name(row),
                identifier,
            )

        completed = historic_completed_event(row, histories.get(identifier, []))
        if completed:
            add_unique_count(
                counters,
                "historic_completed_jobs",
                matched_staff(status_owner(completed), staff_by_key) or job_category_name(row),
                identifier,
            )

    for document in invoice_documents:
        identifier = document_job_id(document)
        activity_rows = activities.get(identifier, [])
        invoiced = latest_matching_activity(activity_rows, INVOICE_CREATED_STATUS_ID)
        if invoiced:
            add_unique_count(
                counters,
                "invoiced_jobs",
                matched_staff(activity_owner(invoiced), staff_by_key),
                identifier,
            )

    for identifier, row in status_jobs.items():
        scheduled = scheduled_from_unallocated_event(histories.get(identifier, []))
        if scheduled:
            add_unique_count(
                counters,
                "scheduled_from_unallocated_jobs",
                matched_staff(status_owner(scheduled), staff_by_key) or job_category_name(row),
                identifier,
            )

    # Display May ex-VAT sales beside counts to match the existing KPI dashboard context.
    sales_decimal = calculate_sales(client, staff_names, REPORT_START, REPORT_END)
    for staff, value in sales_decimal.items():
        sales[staff] = float(value)

    all_staff = sorted(
        {
            staff
            for staff in staff_names
            if any(counters[staff].get(metric, set()) for metric, _ in MOVEMENT_ORDER) or sales.get(staff, 0)
        }
    )
    rows: list[dict[str, Any]] = []
    for staff in all_staff:
        metrics = {metric: len(counters[staff].get(metric, set())) for metric, _ in MOVEMENT_ORDER}
        rows.append(
            {
                "staff_name": staff,
                "metrics": metrics,
                "total_completed_movements": sum(metrics.values()),
                "current_month_sales": sales.get(staff, 0.0),
                "current_month_sales_display": format_currency(sales_decimal.get(staff, DECIMAL_ZERO)),
            }
        )

    rows.sort(key=lambda row: (-row["total_completed_movements"], row["staff_name"]))
    totals = {metric: sum(row["metrics"][metric] for row in rows) for metric, _ in MOVEMENT_ORDER}
    return {
        "run_timestamp": now.isoformat(),
        "period_start": REPORT_START.isoformat(),
        "period_end": REPORT_END.isoformat(),
        "staff_rows": rows,
        "totals": totals,
        "staff_rows_included": len(rows),
        "source_jobs": len(status_jobs),
        "completed_jobs_scanned": len(completed_jobs),
        "financial_documents_scanned": len(financial_documents),
    }


def render_count(value: int) -> str:
    return f'<div class="count-circle"><span>{int(value)}</span></div>'


def render_html(report: dict[str, Any]) -> str:
    rows_html = []
    for idx, row in enumerate(report["staff_rows"], start=1):
        cells = [
            f'<td class="rank">#{idx}</td>',
            f'<td class="staff"><strong>{html.escape(row["staff_name"])}</strong><span>Staff member</span></td>',
        ]
        for metric_key, _label in MOVEMENT_ORDER:
            cells.append(f"<td>{render_count(row['metrics'][metric_key])}</td>")
        cells.append(f"<td class=\"total\"><strong>{row['total_completed_movements']}</strong></td>")
        cells.append(f"<td class=\"sales\">{html.escape(row['current_month_sales_display'])}</td>")
        rows_html.append(f"<tr>{''.join(cells)}</tr>")

    period = f"{html.escape(report['period_start'])} to {html.escape(report['period_end'])}"
    totals = report["totals"]
    return f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>BigChange Completed KPI Movements</title>
  <style>
    :root {{
      --bg: #07111f;
      --panel: #101c2e;
      --panel-2: #14243a;
      --text: #f3f7fb;
      --muted: #94a3b8;
      --blue: #38bdf8;
      --green: #26d07c;
      --line: rgba(148, 163, 184, 0.22);
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      background:
        radial-gradient(circle at 12% 0%, rgba(38, 208, 124, 0.12), transparent 26rem),
        radial-gradient(circle at 88% 0%, rgba(56, 189, 248, 0.16), transparent 30rem),
        var(--bg);
      color: var(--text);
      font-family: Arial, Helvetica, sans-serif;
      padding: 34px;
    }}
    .dashboard {{
      width: 1480px;
      margin: 0 auto;
      background: linear-gradient(180deg, rgba(11, 22, 38, 0.98), rgba(8, 18, 32, 0.98));
      border: 1px solid var(--line);
      border-radius: 24px;
      overflow: hidden;
      box-shadow: 0 26px 70px rgba(0, 0, 0, 0.42);
    }}
    header {{
      padding: 24px 28px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(90deg, rgba(20, 94, 177, 0.18), rgba(38, 208, 124, 0.08));
    }}
    h1 {{
      margin: 0;
      font-size: 24px;
      letter-spacing: -0.03em;
      text-transform: uppercase;
    }}
    .sub {{
      margin-top: 8px;
      color: var(--muted);
      font-size: 13px;
    }}
    .summary {{
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 14px;
      padding: 18px 24px;
      border-bottom: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.018);
    }}
    .card {{
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 14px 16px;
      background: linear-gradient(180deg, rgba(20, 36, 58, 0.74), rgba(13, 26, 45, 0.74));
    }}
    .card span {{
      display: block;
      color: var(--muted);
      font-size: 12px;
      letter-spacing: 0.10em;
      text-transform: uppercase;
    }}
    .card strong {{
      display: block;
      margin-top: 8px;
      font-size: 30px;
      letter-spacing: -0.04em;
      color: var(--green);
    }}
    table {{
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }}
    th {{
      color: #cbd5e1;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.10em;
      font-weight: 700;
      padding: 16px 10px;
      border-bottom: 1px solid var(--line);
      background: rgba(20, 36, 58, 0.74);
    }}
    td {{
      padding: 14px 10px;
      border-bottom: 1px solid var(--line);
      text-align: center;
      vertical-align: middle;
    }}
    tr:nth-child(even) td {{ background: rgba(255, 255, 255, 0.025); }}
    .rank {{ width: 72px; color: #e2e8f0; font-weight: 900; font-size: 18px; }}
    .staff {{ width: 280px; text-align: left; }}
    .staff strong {{ display: block; font-size: 18px; letter-spacing: -0.02em; }}
    .staff span {{ color: var(--muted); font-size: 12px; }}
    .count-circle {{
      width: 66px;
      height: 66px;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 3px solid var(--green);
      color: var(--green);
      background: rgba(255, 255, 255, 0.045);
      box-shadow: inset 0 0 22px rgba(255, 255, 255, 0.05), 0 0 18px rgba(38, 208, 124, 0.12);
    }}
    .count-circle span {{
      font-size: 24px;
      line-height: 1;
      font-weight: 900;
      letter-spacing: -0.05em;
    }}
    .total strong {{ color: var(--blue); font-size: 24px; }}
    .sales {{ color: #f8fafc; font-weight: 800; letter-spacing: -0.03em; }}
    footer {{
      padding: 16px 28px 22px;
      color: var(--muted);
      font-size: 12px;
      border-top: 1px solid var(--line);
    }}
  </style>
</head>
<body>
  <main class="dashboard">
    <header>
      <div>
        <h1>BigChange Completed KPI Movements</h1>
        <div class="sub">May 2026 report period: {period}. Counts are attributed to the BigChange user who made each movement where history is available.</div>
      </div>
      <div class="sub">Generated {html.escape(report["run_timestamp"])}</div>
    </header>
    <section class="summary">
      <div class="card"><span>Jobs actioned</span><strong>{totals["actioned_jobs"]}</strong></div>
      <div class="card"><span>Jobs invoiced</span><strong>{totals["invoiced_jobs"]}</strong></div>
      <div class="card"><span>Unallocated to scheduled</span><strong>{totals["scheduled_from_unallocated_jobs"]}</strong></div>
      <div class="card"><span>Historic to completed</span><strong>{totals["historic_completed_jobs"]}</strong></div>
    </section>
    <table>
      <thead>
        <tr>
          <th>Rank</th>
          <th>Staff member</th>
          <th>Jobs actioned</th>
          <th>Jobs invoiced</th>
          <th>Unallocated to scheduled</th>
          <th>Historic to completed</th>
          <th>Total movements</th>
          <th>May sales</th>
        </tr>
      </thead>
      <tbody>
        {''.join(rows_html)}
      </tbody>
    </table>
    <footer>Source jobs scanned: {int(report["source_jobs"])}. Invoice documents scanned: {int(report["financial_documents_scanned"])}.</footer>
  </main>
</body>
</html>
"""


def render_png(html_content: str, html_path: Path, png_path: Path, row_count: int) -> None:
    html_path.parent.mkdir(parents=True, exist_ok=True)
    png_path.parent.mkdir(parents=True, exist_ok=True)
    html_path.write_text(html_content, encoding="utf-8")
    height = max(780, min(5000, 280 + row_count * 100))
    chrome = optional_env("CHROME_BIN")
    if not chrome:
        chrome = "/opt/google/chrome/chrome" if Path("/opt/google/chrome/chrome").exists() else "google-chrome"
    with tempfile.TemporaryDirectory(prefix="bigchange-chrome-") as profile_dir:
        cmd = [
            chrome,
            "--headless=new",
            "--no-sandbox",
            "--disable-gpu",
            "--hide-scrollbars",
            f"--user-data-dir={profile_dir}",
            f"--window-size=1540,{height}",
            f"--screenshot={png_path}",
            html_path.resolve().as_uri(),
        ]
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)


def send_email(png_path: Path) -> None:
    smtp_host = required_env("SMTP_HOST")
    smtp_port = int(required_env("SMTP_PORT"))
    smtp_username = required_env("SMTP_USERNAME")
    smtp_password = required_env("SMTP_PASSWORD")
    from_email = required_env("SMTP_FROM_EMAIL").strip()
    from_name = optional_env("SMTP_FROM_NAME")
    to_email = optional_env("COMPLETED_REPORT_TO_EMAIL", "daniel.dwyer123@gmail.com").strip()

    root = MIMEMultipart("related")
    root["Subject"] = "BigChange May 2026 Completed KPI Movements"
    root["From"] = str(mailbox_address(from_email, from_name))
    root["To"] = to_email

    alt = MIMEMultipart("alternative")
    root.attach(alt)

    text_body = """Hi Daniel,

Please see attached the BigChange completed KPI movement report for May 2026.

Kind regards,
Daniel Dwyer
"""
    html_body = """<p>Hi Daniel,</p>
<p>Please see attached the BigChange completed KPI movement report for May 2026.</p>
<p><img src="cid:kpi-completed-dashboard" alt="BigChange completed KPI movements" style="max-width: 100%; height: auto;"></p>
<p>Kind regards,<br>Daniel Dwyer</p>"""
    alt.attach(MIMEText(text_body, "plain", "utf-8"))
    alt.attach(MIMEText(html_body, "html", "utf-8"))

    image_data = png_path.read_bytes()
    image = MIMEImage(image_data, _subtype="png")
    image.add_header("Content-ID", "<kpi-completed-dashboard>")
    image.add_header("Content-Disposition", "inline", filename=png_path.name)
    root.attach(image)

    attachment = MIMEBase("image", "png")
    attachment.set_payload(image_data)
    encoders.encode_base64(attachment)
    attachment.add_header("Content-Disposition", "attachment", filename=png_path.name)
    root.attach(attachment)

    with smtplib.SMTP(smtp_host, smtp_port, timeout=120) as smtp:
        smtp.starttls()
        smtp.login(smtp_username, smtp_password)
        smtp.sendmail(from_email, [to_email], root.as_string())


def main() -> int:
    try:
        client = BigChangeClient()
        report = build_completed_report(client)
        html_content = render_html(report)
        reports_dir = Path("reports")
        html_path = reports_dir / "bigchange-kpi-completed-may-2026.html"
        png_path = reports_dir / "bigchange-kpi-completed-may-2026.png"
        json_path = reports_dir / "bigchange-kpi-completed-may-2026.json"
        render_png(html_content, html_path, png_path, len(report["staff_rows"]))
        json_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        send_email(png_path)
        print(
            json.dumps(
                {
                    "email": "sent",
                    "staff_rows_included": report["staff_rows_included"],
                    "jobs_actioned": report["totals"]["actioned_jobs"],
                    "jobs_invoiced": report["totals"]["invoiced_jobs"],
                    "unallocated_to_scheduled": report["totals"]["scheduled_from_unallocated_jobs"],
                    "historic_to_completed": report["totals"]["historic_completed_jobs"],
                },
                sort_keys=True,
            )
        )
        return 0
    except Exception:
        print(
            json.dumps(
                {
                    "email": "failed",
                    "staff_rows_included": 0,
                    "jobs_actioned": 0,
                    "jobs_invoiced": 0,
                    "unallocated_to_scheduled": 0,
                    "historic_to_completed": 0,
                },
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
