#!/usr/bin/env python3
"""Generate and email a May 2026 BigChange completion activity report."""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import re
import smtplib
import subprocess
import tempfile
import time
from collections import Counter
from email import encoders
from email.mime.base import MIMEBase
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from typing import Any

try:
    from bigchange_kpi_report import (
        COMPLETED_STATUS_IDS,
        BigChangeClient,
        as_int,
        clean_name,
        first_present,
        is_populated,
        job_category_name,
        mailbox_address,
        match_staff_name,
        name_key,
        normalized_text,
        optional_env,
        parse_date,
        required_env,
        should_exclude_category,
    )
except ModuleNotFoundError:  # pragma: no cover - used when imported as a package in tests.
    from scripts.bigchange_kpi_report import (
        COMPLETED_STATUS_IDS,
        BigChangeClient,
        as_int,
        clean_name,
        first_present,
        is_populated,
        job_category_name,
        mailbox_address,
        match_staff_name,
        name_key,
        normalized_text,
        optional_env,
        parse_date,
        required_env,
        should_exclude_category,
    )


PERIOD_START = dt.date(2026, 5, 1)
PERIOD_END = dt.date(2026, 5, 31)
PERIOD_END_EXCLUSIVE = PERIOD_END + dt.timedelta(days=1)
SCHEDULED_STATUS_ID = 2
UNALLOCATED_SOURCE_STATUS_IDS = {1, 3}
JOB_CARD_SENT_STATUS_ID = 30

METRICS = [
    ("jobs_actioned", "Jobs actioned"),
    ("jobs_invoiced", "Jobs invoiced"),
    ("unallocated_to_scheduled", "Unallocated to scheduled"),
    ("historic_to_completed", "Historic to completed"),
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--year", type=int, default=2026)
    parser.add_argument("--month", type=int, default=5)
    parser.add_argument("--to-email", default="daniel.dwyer123@gmail.com")
    parser.add_argument("--send-email", action=argparse.BooleanOptionalAction, default=True)
    return parser.parse_args()


def month_period(year: int, month: int) -> tuple[dt.date, dt.date, dt.date]:
    start = dt.date(year, month, 1)
    if month == 12:
        end_exclusive = dt.date(year + 1, 1, 1)
    else:
        end_exclusive = dt.date(year, month + 1, 1)
    return start, end_exclusive - dt.timedelta(days=1), end_exclusive


def in_period(value: dt.datetime | None, start: dt.date, end: dt.date) -> bool:
    return value is not None and start <= value.date() <= end


def truthy_yes(value: Any) -> bool:
    return clean_name(value).lower() in {"1", "true", "yes", "y"}


def job_id(row: dict[str, Any]) -> str:
    return clean_name(first_present(row, ("JobId", "JobID", "JobStatusJobId")))


def document_id(row: dict[str, Any]) -> str:
    return clean_name(first_present(row, ("DocumentId", "DocId", "Id", "DocumentReference")))


def client_status_id(row: dict[str, Any]) -> int | None:
    return as_int(first_present(row, ("ClientStatusId", "ClientStatusID", "JobClientStatusId", "JobClientStatusID")))


def job_status_id(row: dict[str, Any]) -> int | None:
    return as_int(first_present(row, ("JobStatusID", "JobStatusId", "StatusId", "StatusID")))


def job_status_date(row: dict[str, Any]) -> dt.datetime | None:
    return parse_date(first_present(row, ("JobStatusDate", "StatusDate")))


def job_status_owner(row: dict[str, Any]) -> str:
    return clean_name(first_present(row, ("JobStatusOwner", "StatusOwner", "Owner")))


def result_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    return BigChangeClient.result_rows(payload)


def get_staff_names(client: BigChangeClient) -> set[str]:
    staff_names: set[str] = set()
    for category in client.categories():
        name = clean_name(first_present(category, ("label", "JobCategoryName", "CategoryName", "Name")))
        if not should_exclude_category(name):
            staff_names.add(name)
    return staff_names


def get_web_users(client: BigChangeClient) -> dict[str, str]:
    users: dict[str, str] = {}
    for user in client.web_user_list():
        user_id = clean_name(first_present(user, ("id", "UserId", "WebUserId")))
        user_name = clean_name(first_present(user, ("name", "DisplayName", "FullName")))
        if user_id and user_name:
            users[user_id] = user_name
    return users


def owner_key_name(owner: str, staff_by_key: dict[str, str]) -> str:
    if not owner:
        return ""
    matched = match_staff_name(owner, staff_by_key)
    if matched:
        return matched
    return owner


def jobslist_all(client: BigChangeClient, params: dict[str, Any]) -> list[dict[str, Any]]:
    return client.jobslist(params)


def job_status_history(client: BigChangeClient, item_job_id: str, delay_seconds: float) -> list[dict[str, Any]]:
    if delay_seconds > 0:
        time.sleep(delay_seconds)
    payload = client.get("jobstatushistory", {"JobId": item_job_id}, timeout=30, attempts=5)
    if payload.get("Code") != 0:
        return []
    return sorted(result_rows(payload), key=lambda row: job_status_date(row) or dt.datetime.min)


def job_customer_activity(client: BigChangeClient, item_job_id: str, delay_seconds: float) -> list[dict[str, Any]]:
    if delay_seconds > 0:
        time.sleep(delay_seconds)
    payload = client.get("jobcustomeractivity", {"JobId": item_job_id}, timeout=30, attempts=5)
    if payload.get("Code") != 0:
        return []
    return result_rows(payload)


def render_dashboard_png(html_content: str, html_path: Path, png_path: Path, row_count: int) -> None:
    html_path.parent.mkdir(parents=True, exist_ok=True)
    png_path.parent.mkdir(parents=True, exist_ok=True)
    html_path.write_text(html_content, encoding="utf-8")
    height = max(780, min(5000, 260 + row_count * 130))
    chrome = optional_env("CHROME_BIN")
    if not chrome:
        chrome = "/opt/google/chrome/chrome" if Path("/opt/google/chrome/chrome").exists() else "google-chrome"
    with tempfile.TemporaryDirectory(prefix="bigchange-completion-chrome-") as profile_dir:
        cmd = [
            chrome,
            "--headless=new",
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--hide-scrollbars",
            f"--user-data-dir={profile_dir}",
            f"--window-size=1540,{height}",
            f"--screenshot={png_path}",
            html_path.resolve().as_uri(),
        ]
        process = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            process.wait(timeout=45)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)
            if png_path.exists() and png_path.stat().st_size > 0:
                return
            raise
        if process.returncode != 0:
            raise subprocess.CalledProcessError(process.returncode, cmd)
        if not png_path.exists() or png_path.stat().st_size == 0:
            raise RuntimeError("Chrome did not create the completion report PNG")


def active_invoice_documents(client: BigChangeClient, start: dt.date, end: dt.date) -> list[dict[str, Any]]:
    documents = client.invoices_with_items_by_period(start, end)
    eligible: list[dict[str, Any]] = []
    for document in documents:
        order_type = re.sub(
            r"[^a-z]",
            "",
            clean_name(first_present(document, ("OrderType", "DocumentType", "DocType"))).lower(),
        )
        if order_type != "invoice":
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
        eligible.append(document)
    return eligible


def count_invoiced_jobs(
    client: BigChangeClient,
    staff_by_key: dict[str, str],
    web_users: dict[str, str],
    start: dt.date,
    end: dt.date,
) -> Counter[str]:
    counts: Counter[str] = Counter()
    seen_by_owner: set[tuple[str, str]] = set()
    for document in active_invoice_documents(client, start, end):
        creator = clean_name(first_present(document, ("OrderCreator", "DocumentCreator", "CreatedBy", "Creator")))
        creator_name = web_users.get(creator, creator)
        owner = owner_key_name(creator_name, staff_by_key)
        if not owner:
            continue
        # Prefer counting a job once per creator; fall back to the document for non-job invoices.
        item_id = job_id(document) or document_id(document)
        if not item_id:
            continue
        key = (owner, item_id)
        if key in seen_by_owner:
            continue
        seen_by_owner.add(key)
        counts[owner] += 1
    return counts


def scheduled_from_unallocated_event(
    history: list[dict[str, Any]],
    start: dt.date,
    end: dt.date,
) -> dict[str, Any] | None:
    previous_status: int | None = None
    chosen: dict[str, Any] | None = None
    for row in history:
        status_id = job_status_id(row)
        status_date = job_status_date(row)
        if status_id == SCHEDULED_STATUS_ID and previous_status in UNALLOCATED_SOURCE_STATUS_IDS and in_period(status_date, start, end):
            chosen = row
        if status_id is not None:
            previous_status = status_id
    return chosen


def completed_from_historic_event(
    job: dict[str, Any],
    history: list[dict[str, Any]],
    start: dt.date,
    end: dt.date,
) -> dict[str, Any] | None:
    planned_start = parse_date(first_present(job, ("PlannedStart", "ScheduledStart")))
    if planned_start is None:
        return None
    for row in history:
        status_id = job_status_id(row)
        status_date = job_status_date(row)
        if status_id not in COMPLETED_STATUS_IDS or not in_period(status_date, start, end):
            continue
        if planned_start.date() < status_date.date():
            return row
    return None


def latest_job_card_sent_owner(
    activity: list[dict[str, Any]],
    start: dt.date,
    end: dt.date,
) -> str:
    candidates: list[tuple[dt.datetime, str]] = []
    for row in activity:
        status_id = client_status_id(row)
        status_name = normalized_text(clean_name(first_present(row, ("JobClientStatus", "ClientStatus"))))
        status_date = parse_date(first_present(row, ("JobClientStatusDate", "ClientStatusDate")))
        if status_id == JOB_CARD_SENT_STATUS_ID or status_name == "jobcardsent":
            if in_period(status_date, start, end):
                candidates.append((status_date or dt.datetime.min, clean_name(first_present(row, ("JobClientStatusOwner", "Owner")))))
    if not candidates:
        return ""
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def build_report(client: BigChangeClient, start: dt.date, end: dt.date, end_exclusive: dt.date) -> dict[str, Any]:
    staff_names = get_staff_names(client)
    staff_by_key = {name_key(name): name for name in staff_names if name_key(name)}
    web_users = get_web_users(client)
    request_delay = float(optional_env("BIGCHANGE_REPORT_REQUEST_DELAY", "0.08"))

    completed_jobs = jobslist_all(
        client,
        {
            "Start": start.isoformat(),
            "End": end_exclusive.isoformat(),
            "DateOptionId": 4,
            "StatusId": "|".join(str(status_id) for status_id in sorted(COMPLETED_STATUS_IDS)),
        },
    )
    completed_jobs = [
        row
        for row in completed_jobs
        if as_int(first_present(row, ("StatusId", "StatusID"))) in COMPLETED_STATUS_IDS
        and in_period(parse_date(first_present(row, ("StatusDate", "JobStatusDate"))), start, end)
        and not should_exclude_category(job_category_name(row))
    ]

    metrics: dict[str, Counter[str]] = {metric: Counter() for metric, _label in METRICS}
    actioned_job_ids = [job_id(row) for row in completed_jobs if truthy_yes(first_present(row, ("Actioned", "IsActioned")))]
    actioned_job_ids = [item for item in actioned_job_ids if item]

    # The Actioned flag does not carry its own timestamp in JobsList, so the May scope is the
    # completed-status date and the owner is the job category staff owner.
    for row in completed_jobs:
        if not truthy_yes(first_present(row, ("Actioned", "IsActioned"))):
            continue
        owner = job_category_name(row)
        if owner:
            metrics["jobs_actioned"][owner] += 1

    metrics["jobs_invoiced"].update(count_invoiced_jobs(client, staff_by_key, web_users, start, end))

    scheduled_jobs = jobslist_all(
        client,
        {
            "Start": start.isoformat(),
            "End": end_exclusive.isoformat(),
            "DateOptionId": 4,
            "StatusId": str(SCHEDULED_STATUS_ID),
        },
    )
    scheduled_jobs = [
        row
        for row in scheduled_jobs
        if as_int(first_present(row, ("StatusId", "StatusID"))) == SCHEDULED_STATUS_ID
        and in_period(parse_date(first_present(row, ("StatusDate", "JobStatusDate"))), start, end)
        and not should_exclude_category(job_category_name(row))
    ]

    for row in scheduled_jobs:
        item_job_id = job_id(row)
        if not item_job_id:
            continue
        event = scheduled_from_unallocated_event(job_status_history(client, item_job_id, request_delay), start, end)
        if event is None:
            continue
        owner = owner_key_name(job_status_owner(event), staff_by_key) or job_category_name(row)
        if owner:
            metrics["unallocated_to_scheduled"][owner] += 1

    historic_candidates = []
    for row in completed_jobs:
        planned_start = parse_date(first_present(row, ("PlannedStart", "ScheduledStart")))
        status_date = parse_date(first_present(row, ("StatusDate", "JobStatusDate")))
        if planned_start and status_date and planned_start.date() < status_date.date():
            historic_candidates.append(row)

    for row in historic_candidates:
        item_job_id = job_id(row)
        if not item_job_id:
            continue
        event = completed_from_historic_event(row, job_status_history(client, item_job_id, request_delay), start, end)
        if event is None:
            continue
        owner = owner_key_name(job_status_owner(event), staff_by_key) or job_category_name(row)
        if owner:
            metrics["historic_to_completed"][owner] += 1

    people = sorted(set().union(*(set(counter) for counter in metrics.values())))
    rows = []
    for person in people:
        metric_values = {metric: int(metrics[metric][person]) for metric, _label in METRICS}
        total = sum(metric_values.values())
        if total == 0:
            continue
        rows.append({"staff_name": person, "metrics": metric_values, "total_completed": total})
    rows.sort(key=lambda row: (-row["total_completed"], row["staff_name"]))

    return {
        "run_timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
        "period_start": start.isoformat(),
        "period_end": end.isoformat(),
        "staff_rows": rows,
        "totals": {metric: int(sum(counter.values())) for metric, counter in metrics.items()},
        "source_counts": {
            "completed_jobs": len(completed_jobs),
            "actioned_jobs": len(actioned_job_ids),
            "scheduled_jobs_reviewed": len(scheduled_jobs),
            "historic_completed_candidates": len(historic_candidates),
        },
    }


def render_number(value: int) -> str:
    return f'<div class="number-bubble"><span>{value}</span></div>'


def render_html(report: dict[str, Any]) -> str:
    rows_html = []
    for idx, row in enumerate(report["staff_rows"], start=1):
        cells = [
            f'<td class="rank">#{idx}</td>',
            f'<td class="staff"><strong>{html.escape(row["staff_name"])}</strong><span>Staff member / activity owner</span></td>',
        ]
        for metric, _label in METRICS:
            cells.append(f"<td>{render_number(int(row['metrics'][metric]))}</td>")
        cells.append(f"<td>{render_number(int(row['total_completed']))}</td>")
        rows_html.append(f"<tr>{''.join(cells)}</tr>")

    totals = report["totals"]
    total_all = sum(int(totals[metric]) for metric, _label in METRICS)
    period_start = html.escape(report["period_start"])
    period_end = html.escape(report["period_end"])
    generated = html.escape(report["run_timestamp"])
    cards = "".join(
        f'<div class="total-card"><span>{html.escape(label)}</span><strong>{int(totals[metric])}</strong></div>'
        for metric, label in METRICS
    )
    return f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>BigChange May Completion Report</title>
  <style>
    :root {{
      --bg: #07111f;
      --panel: #101c2e;
      --panel-2: #14243a;
      --text: #f3f7fb;
      --muted: #94a3b8;
      --green: #26d07c;
      --blue: #38bdf8;
      --purple: #a78bfa;
      --line: rgba(148, 163, 184, 0.22);
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      background:
        radial-gradient(circle at 8% 0%, rgba(38, 208, 124, 0.14), transparent 26rem),
        radial-gradient(circle at 90% 4%, rgba(56, 189, 248, 0.13), transparent 28rem),
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
      background:
        linear-gradient(90deg, rgba(20, 94, 177, 0.18), rgba(38, 208, 124, 0.08), rgba(167, 139, 250, 0.12)),
        rgba(10, 21, 38, 0.84);
    }}
    h1 {{
      margin: 0;
      font-size: 24px;
      letter-spacing: -0.03em;
      line-height: 1.1;
      text-transform: uppercase;
    }}
    .sub {{
      margin-top: 8px;
      color: var(--muted);
      font-size: 13px;
    }}
    .hero-total {{
      min-width: 150px;
      padding: 14px 18px;
      border-radius: 18px;
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.055);
      text-align: center;
    }}
    .hero-total strong {{
      display: block;
      color: var(--green);
      font-size: 34px;
      line-height: 1;
    }}
    .hero-total span {{
      display: block;
      margin-top: 6px;
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.11em;
    }}
    .total-cards {{
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 14px;
      padding: 18px 24px;
      border-bottom: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.018);
    }}
    .total-card {{
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 14px 16px;
      background: linear-gradient(180deg, rgba(20, 36, 58, 0.74), rgba(13, 26, 45, 0.74));
    }}
    .total-card span {{
      display: block;
      color: var(--muted);
      font-size: 12px;
      letter-spacing: 0.10em;
      text-transform: uppercase;
    }}
    .total-card strong {{
      display: block;
      margin-top: 8px;
      font-size: 30px;
      letter-spacing: -0.04em;
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
      letter-spacing: 0.11em;
      font-weight: 700;
      padding: 16px 10px;
      border-bottom: 1px solid var(--line);
      background: rgba(20, 36, 58, 0.74);
    }}
    th:nth-child(1), td:nth-child(1) {{ width: 72px; }}
    th:nth-child(2), td:nth-child(2) {{ width: 310px; }}
    td {{
      padding: 13px 10px;
      border-bottom: 1px solid var(--line);
      text-align: center;
      vertical-align: middle;
    }}
    tr:nth-child(even) td {{ background: rgba(255, 255, 255, 0.025); }}
    tr:last-child td {{ border-bottom: none; }}
    .rank {{
      color: #e2e8f0;
      font-weight: 900;
      font-size: 18px;
    }}
    .staff {{
      text-align: left;
      padding-left: 12px;
    }}
    .staff strong {{
      display: block;
      font-size: 18px;
      letter-spacing: -0.02em;
    }}
    .staff span {{
      display: block;
      margin-top: 3px;
      color: var(--muted);
      font-size: 12px;
    }}
    .number-bubble {{
      width: 62px;
      height: 62px;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: rgba(255, 255, 255, 0.045);
      border: 3px solid var(--green);
      color: var(--green);
      box-shadow: inset 0 0 22px rgba(255, 255, 255, 0.05), 0 0 18px rgba(38, 208, 124, 0.10);
    }}
    .number-bubble span {{
      font-size: 23px;
      line-height: 1;
      font-weight: 900;
      letter-spacing: -0.05em;
    }}
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
        <h1>BigChange May Completion Report</h1>
        <div class="sub">Completed activity from {period_start} to {period_end}. Grouped by staff owner/activity user where BigChange exposes an owner.</div>
      </div>
      <div class="hero-total"><strong>{total_all}</strong><span>Total actions</span></div>
    </header>
    <section class="total-cards">{cards}</section>
    <table>
      <thead>
        <tr>
          <th>Rank</th>
          <th>Staff member</th>
          <th>Jobs actioned</th>
          <th>Jobs invoiced</th>
          <th>Unallocated to scheduled</th>
          <th>Historic to completed</th>
          <th>Total</th>
        </tr>
      </thead>
      <tbody>{''.join(rows_html)}</tbody>
    </table>
    <footer>Generated {generated}. Invoiced counts use active May invoice documents, de-duplicated by linked job where present. Scheduled/completed movement uses BigChange job status history owners.</footer>
  </main>
</body>
</html>
"""


def send_email(png_path: Path, to_email: str, report: dict[str, Any]) -> None:
    smtp_host = required_env("SMTP_HOST")
    smtp_port = int(required_env("SMTP_PORT"))
    smtp_username = required_env("SMTP_USERNAME")
    smtp_password = required_env("SMTP_PASSWORD")
    from_email = required_env("SMTP_FROM_EMAIL").strip()
    from_name = optional_env("SMTP_FROM_NAME")

    subject = "BigChange May 2026 Completion Report"
    root = MIMEMultipart("related")
    root["Subject"] = subject
    root["From"] = str(mailbox_address(from_email, from_name))
    root["To"] = to_email

    alt = MIMEMultipart("alternative")
    root.attach(alt)
    period = f"{report['period_start']} to {report['period_end']}"
    text_body = f"""Hi Daniel,

Please find attached the BigChange completion report for {period}.

Kind regards,
Daniel Dwyer
"""
    html_body = f"""<p>Hi Daniel,</p>
<p>Please find attached the BigChange completion report for {html.escape(period)}.</p>
<p><img src="cid:completion-dashboard" alt="BigChange May completion dashboard" style="max-width: 100%; height: auto;"></p>
<p>Kind regards,<br>Daniel Dwyer</p>"""
    alt.attach(MIMEText(text_body, "plain", "utf-8"))
    alt.attach(MIMEText(html_body, "html", "utf-8"))

    image_data = png_path.read_bytes()
    image = MIMEImage(image_data, _subtype="png")
    image.add_header("Content-ID", "<completion-dashboard>")
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
    args = parse_args()
    start, end, end_exclusive = month_period(args.year, args.month)
    reports_dir = Path("reports")
    html_path = reports_dir / "bigchange-may-completion-report.html"
    png_path = reports_dir / "bigchange-may-completion-report.png"

    try:
        client = BigChangeClient()
        report = build_report(client, start, end, end_exclusive)
        html_content = render_html(report)
        render_dashboard_png(html_content, html_path, png_path, len(report["staff_rows"]))
        if args.send_email:
            send_email(png_path, args.to_email, report)
            email_status = "sent"
        else:
            email_status = "not_sent"
        print(
            json.dumps(
                {
                    "staff_rows_included": len(report["staff_rows"]),
                    "jobs_actioned": report["totals"]["jobs_actioned"],
                    "jobs_invoiced": report["totals"]["jobs_invoiced"],
                    "unallocated_to_scheduled": report["totals"]["unallocated_to_scheduled"],
                    "historic_to_completed": report["totals"]["historic_to_completed"],
                    "email": email_status,
                },
                sort_keys=True,
            )
        )
        return 0
    except Exception:
        print(
            json.dumps(
                {
                    "staff_rows_included": 0,
                    "jobs_actioned": 0,
                    "jobs_invoiced": 0,
                    "unallocated_to_scheduled": 0,
                    "historic_to_completed": 0,
                    "email": "failed",
                },
                sort_keys=True,
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
