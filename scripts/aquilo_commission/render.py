"""Email-safe HTML packs for Aquilo AM commission scorecards."""

from __future__ import annotations

import base64
import datetime as dt
import html
from pathlib import Path
from typing import Any

from .commission import MonthlyQualification, qualify_month, sum_job_commissions
from .settings import COMPANY_NAME, LABOUR_RATE
from .util import format_margin, gbp, money

D = __import__("decimal").Decimal
ZERO = D("0")

GROKBOT_CID = "grokbot-icon"
GROKBOT_PATH = Path(__file__).resolve().parent / "assets" / "grokbot.png"
GROKBOT_MIME = "image/jpeg"

QUIET = "color:#5b6775;font-size:11px;font-weight:400;"
HEAD = "background:#1f3a5f;color:#fff;"
TABLE_CSS = "border-collapse:collapse;font-size:12px;border-color:#d5dde6;width:100%;"
CELL = "padding:8px 10px;border:1px solid #d5dde6;"
NAVY = "#1f3a5f"
COPY = "font-size:16px;line-height:1.6;color:#243040;"


def grokbot_bytes() -> bytes:
    return GROKBOT_PATH.read_bytes()


def grokbot_src(*, inline_email: bool) -> str:
    if inline_email:
        return f"cid:{GROKBOT_CID}"
    raw = grokbot_bytes()
    encoded = base64.b64encode(raw).decode("ascii")
    return f"data:{GROKBOT_MIME};base64,{encoded}"


def margin_style(margin: D | None) -> str:
    if margin is None:
        return ""
    if margin < D("20"):
        return "background:#f8d7da;color:#721c24;font-weight:700;"
    if margin < D("35"):
        return "background:#fff3cd;color:#856404;font-weight:700;"
    if margin > D("45"):
        return "background:#d4edda;color:#155724;font-weight:700;"
    return ""


def commission_style(value: D) -> str:
    if value > 0:
        return "color:#155724;font-weight:700;"
    if value < 0:
        return "color:#721c24;font-weight:700;"
    return "color:#555;"


def _td(text: str, extra: str = "", align: str = "left") -> str:
    return f"<td style='{CELL}text-align:{align};white-space:nowrap;{extra}'>{text}</td>"


def _td_money(value: D, extra: str = "") -> str:
    return _td(gbp(value), extra, align="right")


def _th(label: str, extra: str = "") -> str:
    return f"<th style='{CELL}{HEAD}{extra}'>{html.escape(label)}</th>"


def _tile(label: str, value: str, bg: str) -> str:
    return (
        f"<td width='32%' bgcolor='{bg}' style='background:{bg};padding:16px 14px;"
        f"color:#fff;vertical-align:top;border-radius:4px;'>"
        f"<p style='margin:0 0 8px;font-size:12px;line-height:1.4;letter-spacing:0.02em;'>"
        f"{html.escape(label)}</p>"
        f"<p style='margin:0;font-size:20px;line-height:1.3;font-weight:700;'>{value}</p>"
        f"</td>"
    )


def _gutter() -> str:
    return "<td width='8' style='width:8px;font-size:8px;line-height:8px;'>&nbsp;</td>"


def _row_gap() -> str:
    return "<tr><td colspan='5' style='height:8px;font-size:8px;line-height:8px;'>&nbsp;</td></tr>"


def grokbot_img(src: str, size: int = 56) -> str:
    return (
        f"<img src='{html.escape(src, quote=True)}' width='{size}' height='{size}' "
        f"alt='Grokbot' style='display:block;width:{size}px;height:{size}px;border:0;' />"
    )


def render_scorecard(
    *,
    staff_name: str,
    month_label: str,
    qualification: MonthlyQualification,
    icon_src: str,
) -> str:
    tiles = [
        ("Overall profit", gbp(qualification.total_profit), "#1f3a5f"),
        ("Invoiced", gbp(qualification.total_revenue), "#2e5a8f"),
        ("Purchase orders", gbp(qualification.total_po), "#3d6fa3"),
        ("Labour", gbp(qualification.total_labour), "#4a82b8"),
        ("Margin", format_margin(qualification.overall_margin), "#3b6d99"),
        ("Commission", gbp(qualification.payable_commission), "#1b7a4a"),
    ]
    top = tiles[:3]
    bottom = tiles[3:]
    return f"""
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px;border:1px solid #d5dde6;background:#ffffff;">
      <tr>
        <td bgcolor="{NAVY}" style="background:{NAVY};padding:18px 20px;">
          <table cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td valign="middle" style="padding-right:14px;">{grokbot_img(icon_src)}</td>
              <td valign="middle">
                <p style="margin:0 0 4px;font-size:12px;letter-spacing:0.08em;color:#d7e3f2;text-transform:uppercase;">Grokbot scorecard</p>
                <p style="margin:0 0 4px;font-size:20px;line-height:1.3;font-weight:700;color:#ffffff;">{html.escape(staff_name)}</p>
                <p style="margin:0;font-size:14px;line-height:1.4;color:#d7e3f2;">{html.escape(COMPANY_NAME)} · {html.escape(month_label)}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 16px 18px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              {_tile(*top[0])}{_gutter()}{_tile(*top[1])}{_gutter()}{_tile(*top[2])}
            </tr>
            {_row_gap()}
            <tr>
              {_tile(*bottom[0])}{_gutter()}{_tile(*bottom[1])}{_gutter()}{_tile(*bottom[2])}
            </tr>
          </table>
        </td>
      </tr>
    </table>
    """


def _kv(label: str, value: str, *, first: bool = False) -> str:
    pad = "0 0 12px" if first else "0 0 12px"
    return (
        "<tr>"
        f"<td valign='top' style='padding:{pad};font-size:15px;line-height:1.5;color:#5b6775;width:48%;'>{html.escape(label)}</td>"
        f"<td valign='top' style='padding:{pad};font-size:15px;line-height:1.5;font-weight:700;color:#1a2433;text-align:right;'>{value}</td>"
        "</tr>"
    )


def render_qualification(q: MonthlyQualification) -> str:
    if q.qualified:
        status_bg, status_fg, lead = "#e5f6ea", "#155724", "You have unlocked payable commission for this month."
    else:
        status_bg, status_fg, lead = (
            "#fff6dc",
            "#7a5b00",
            "Payable commission stays at £0.00 until month profit reaches £11,000.",
        )
    coach = ""
    if q.coach_line:
        coach = f"""
        <tr>
          <td colspan="2" style="padding:16px 0 0;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef4fb;border:1px solid #d5e2f0;">
              <tr>
                <td style="padding:14px 16px;">
                  <p style="margin:0 0 6px;font-size:12px;letter-spacing:0.06em;color:{NAVY};text-transform:uppercase;font-weight:700;">Grokbot tip</p>
                  <p style="margin:0;font-size:15px;line-height:1.55;color:#243040;">{html.escape(q.coach_line)}</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        """
    return f"""
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 32px;">
      <tr>
        <td>
          <p style="margin:0 0 8px;font-size:18px;line-height:1.4;font-weight:700;color:{NAVY};">How you stand this month</p>
          <p style="margin:0 0 16px;{COPY}">{html.escape(lead)}</p>
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            {_kv("Minimum profit to unlock payment", gbp(q.min_profit), first=True)}
            {_kv("Your profit so far", gbp(q.total_profit))}
            {_kv("Still to go", gbp(q.profit_remaining))}
            {_kv("Running commission (shown on jobs)", gbp(q.running_commission))}
            {_kv("Payable commission", gbp(q.payable_commission))}
            {_kv("Target margin (for coaching)", format_margin(q.min_margin_message))}
          </table>
          <p style="margin:8px 0 0;padding:12px 14px;background:{status_bg};color:{status_fg};font-weight:700;font-size:15px;line-height:1.4;">
            Status: {html.escape(q.status)}
          </p>
          <table width="100%" cellpadding="0" cellspacing="0" border="0">{coach}</table>
        </td>
      </tr>
    </table>
    """


DAY = "background:#eef2f6;color:#4a5560;font-size:11px;font-weight:600;"


def day_subtotal(day: dt.date, jobs: list[dict[str, Any]]) -> dict[str, Any]:
    """Sum stored job figures for one invoice day. Do not rerun commission."""
    sale = money(sum((r["sale"] for r in jobs), ZERO))
    cost = money(sum((r["cost"] for r in jobs), ZERO))
    labour = money(sum((r.get("labour") or ZERO for r in jobs), ZERO))
    profit = money(sum((r["profit"] for r in jobs), ZERO))
    label = f"{day.strftime('%d/%m/%Y')} · {len(jobs)} job{'s' if len(jobs) != 1 else ''}"
    return {
        "kind": "day_total",
        "date": day,
        "reference": label,
        "sale": sale,
        "cost": cost,
        "labour": labour,
        "profit": profit,
        "margin": (profit / sale * D("100")) if sale != 0 else None,
        "commission": sum_job_commissions(jobs),
        "running_profit": jobs[-1]["running_profit"],
        "running_commission": jobs[-1]["running_commission"],
    }


def iter_display_rows(job_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    last_day: dt.date | None = None
    day_jobs: list[dict[str, Any]] = []
    for row in job_rows:
        if last_day is not None and row["date"] != last_day:
            rows.append(day_subtotal(last_day, day_jobs))
            day_jobs = []
        rows.append({**row, "kind": "job"})
        day_jobs.append(row)
        last_day = row["date"]
    if last_day is not None and day_jobs:
        rows.append(day_subtotal(last_day, day_jobs))
    return rows


def render_job_table(job_rows: list[dict[str, Any]]) -> str:
    if not job_rows:
        return "<p style='margin:0 0 28px;font-size:15px;line-height:1.6;color:#243040;'>No qualifying groups in this month.</p>"
    body = []
    for row in iter_display_rows(job_rows):
        if row["kind"] == "day_total":
            ms = format_margin(row.get("margin"))
            body.append(
                "<tr style='background:#eef2f6;'>"
                + _td(html.escape(str(row["reference"])), DAY, align="left")
                + _td("Day total", DAY, align="left")
                + _td_money(row["sale"], DAY)
                + _td_money(row["cost"], DAY)
                + _td_money(row.get("labour") or ZERO, DAY)
                + _td_money(row["profit"], DAY)
                + _td(ms, DAY, align="right")
                + _td_money(row["commission"], DAY)
                + _td_money(row["running_profit"], DAY)
                + _td_money(row["running_commission"], DAY)
                + "</tr>"
            )
            continue
        ms = format_margin(row.get("margin"))
        body.append(
            "<tr>"
            + _td(row["date"].strftime("%d/%m/%Y"))
            + _td(html.escape(str(row["reference"])))
            + _td_money(row["sale"])
            + _td_money(row["cost"])
            + _td_money(row.get("labour") or ZERO)
            + _td_money(row["profit"])
            + _td(ms, margin_style(row.get("margin")), align="right")
            + _td_money(row["commission"], commission_style(row["commission"]))
            + _td_money(row["running_profit"], QUIET)
            + _td_money(row["running_commission"], QUIET)
            + "</tr>"
        )
    total_sale = money(sum((r["sale"] for r in job_rows), ZERO))
    total_po = money(sum((r["cost"] for r in job_rows), ZERO))
    total_labour = money(sum((r.get("labour") or ZERO for r in job_rows), ZERO))
    total_profit = money(sum((r["profit"] for r in job_rows), ZERO))
    total_margin = (total_profit / total_sale * D("100")) if total_sale != 0 else None
    total_commission = sum_job_commissions(job_rows)
    body.append(
        f"<tr style='{HEAD}font-weight:700;'>"
        + _td(f"Total — {len(job_rows)} groups/jobs", HEAD, align="left")
        + _td("", HEAD)
        + _td_money(total_sale, HEAD)
        + _td_money(total_po, HEAD)
        + _td_money(total_labour, HEAD)
        + _td_money(total_profit, HEAD)
        + _td(format_margin(total_margin), HEAD, align="right")
        + _td_money(total_commission, HEAD)
        + _td_money(total_profit, HEAD)
        + _td_money(total_commission, HEAD)
        + "</tr>"
    )
    return f"""
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px;">
      <tr>
        <td>
          <p style="margin:0 0 8px;font-size:18px;line-height:1.4;font-weight:700;color:{NAVY};">Your jobs this month</p>
          <p style="margin:0 0 14px;{COPY}">
            One row per job group, in invoice-date order, with a smaller day total under each date.
            Labour is planned hours at {gbp(LABOUR_RATE)}/h. Commission is calculated on the group, never on a line or a day total.
          </p>
        </td>
      </tr>
    </table>
    <table cellpadding="0" cellspacing="0" border="1" style="{TABLE_CSS}margin:0 0 28px;">
      <thead>
        <tr>
          {_th("Date")}{_th("Group/job")}{_th("Invoiced")}{_th("Purchase orders")}
          {_th("Labour")}{_th("Profit")}{_th("Margin")}{_th("Commission")}
          {_th("Run profit")}{_th("Run comm")}
        </tr>
      </thead>
      <tbody>{''.join(body)}</tbody>
    </table>
    """


def render_anomaly_table(rows: list[dict[str, Any]]) -> str:
    if not rows:
        return ""
    body = []
    for row in rows:
        body.append(
            "<tr>"
            + _td(row["date"].strftime("%d/%m/%Y"))
            + _td(html.escape(str(row["reference"])))
            + _td_money(row["sale"])
            + _td_money(row["cost"])
            + _td_money(row.get("labour") or ZERO)
            + _td_money(row["profit"])
            + _td(format_margin(row.get("margin")), margin_style(row.get("margin")), align="right")
            + _td(html.escape(row.get("reason") or ""), align="left")
            + "</tr>"
        )
    return f"""
    <p style="margin:0 0 8px;font-size:18px;line-height:1.4;font-weight:700;color:#721c24;">Anomalies left out of totals</p>
    <p style="margin:0 0 14px;{COPY}">These groups invoiced more than £250 with no purchase order. Labour is not treated as a PO.</p>
    <table cellpadding="0" cellspacing="0" border="1" style="{TABLE_CSS}margin:0 0 28px;">
      <thead>
        <tr>
          {_th("Date")}{_th("Group/job")}{_th("Invoiced")}{_th("Purchase orders")}
          {_th("Labour")}{_th("Profit")}{_th("Margin")}{_th("Reason")}
        </tr>
      </thead>
      <tbody>{''.join(body)}</tbody>
    </table>
    """


def render_review_table(rows: list[dict[str, Any]]) -> str:
    if not rows:
        return ""
    body = []
    for row in rows:
        flags = ", ".join(row.get("flags") or [])
        body.append(
            "<tr>"
            + _td(row["date"].strftime("%d/%m/%Y"))
            + _td(html.escape(str(row["reference"])))
            + _td_money(row["sale"])
            + _td_money(row["profit"])
            + _td(format_margin(row.get("margin")), margin_style(row.get("margin")), align="right")
            + _td(html.escape(flags), align="left")
            + "</tr>"
        )
    return f"""
    <p style="margin:0 0 8px;font-size:18px;line-height:1.4;font-weight:700;color:#856404;">Worth a second look</p>
    <p style="margin:0 0 14px;{COPY}">Flagged groups only — they still sit in the main table above.</p>
    <table cellpadding="0" cellspacing="0" border="1" style="{TABLE_CSS}margin:0 0 28px;">
      <thead>
        <tr>
          {_th("Date")}{_th("Group/job")}{_th("Invoiced")}{_th("Profit")}{_th("Margin")}{_th("Flag")}
        </tr>
      </thead>
      <tbody>{''.join(body)}</tbody>
    </table>
    """


def render_report(
    *,
    staff_name: str,
    month_label: str,
    first_name: str,
    job_rows: list[dict[str, Any]],
    anomaly_rows: list[dict[str, Any]],
    review_rows: list[dict[str, Any]],
    qualification: MonthlyQualification,
    preview: bool = True,
    inline_email: bool = False,
) -> str:
    icon_src = grokbot_src(inline_email=inline_email)
    preview_note = (
        "<p style='margin:0 0 20px;padding:12px 14px;background:#eef4fb;border:1px solid #d5e2f0;"
        "font-size:14px;line-height:1.55;color:#1f3a5f;'>"
        "This is a preview pack. It has not been sent to the account manager."
        "</p>"
        if preview
        else ""
    )
    greeting = f"""
      <p style="margin:0 0 12px;font-size:22px;line-height:1.4;font-weight:700;color:{NAVY};">Hi {html.escape(first_name)},</p>
      <p style="margin:0 0 12px;{COPY}">
        Here is your {html.escape(month_label)} {html.escape(COMPANY_NAME)} commission pack.
        The scorecard is the month in one view. The job table underneath is the full story, and a copy is attached if you want to keep it.
      </p>
      <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#5b6775;">
        Payroll Labour uses planned hours at {gbp(LABOUR_RATE)}/h, not timesheets. Quotes are ignored.
      </p>
    """
    signoff = """
      <p style="margin:8px 0 0;font-size:16px;line-height:1.6;color:#243040;">
        Kind regards,<br>
        Daniel Dwyer
      </p>
    """
    return f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{html.escape(staff_name)} {html.escape(month_label)} Aquilo commission</title>
</head>
<body style="margin:0;padding:0;background:#e8eef5;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#e8eef5;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table width="680" cellpadding="0" cellspacing="0" border="0" style="width:680px;max-width:680px;background:#ffffff;">
          <tr>
            <td style="padding:28px 28px 32px;">
              {greeting}
              {preview_note}
              {render_scorecard(staff_name=staff_name, month_label=month_label, qualification=qualification, icon_src=icon_src)}
              {render_qualification(qualification)}
              {render_job_table(job_rows)}
              {render_anomaly_table(anomaly_rows)}
              {render_review_table(review_rows)}
              {signoff}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
"""


def build_full_html(
    *,
    staff_name: str,
    month_label: str,
    job_rows: list[dict[str, Any]],
    anomaly_rows: list[dict[str, Any]],
    review_rows: list[dict[str, Any]],
    qualification: MonthlyQualification,
    preview: bool = True,
) -> str:
    first = staff_name.split()[0] if staff_name.strip() else staff_name
    return render_report(
        staff_name=staff_name,
        month_label=month_label,
        first_name=first,
        job_rows=job_rows,
        anomaly_rows=anomaly_rows,
        review_rows=review_rows,
        qualification=qualification,
        preview=preview,
        inline_email=False,
    )


def build_email_body(
    *,
    staff_name: str,
    month_label: str,
    first_name: str,
    qualification: MonthlyQualification,
    job_rows: list[dict[str, Any]],
    anomaly_rows: list[dict[str, Any]] | None = None,
    review_rows: list[dict[str, Any]] | None = None,
    preview: bool = True,
) -> str:
    """Full pack in the email body: greeting, Grokbot scorecard, then the job table."""
    return render_report(
        staff_name=staff_name,
        month_label=month_label,
        first_name=first_name,
        job_rows=job_rows,
        anomaly_rows=anomaly_rows or [],
        review_rows=review_rows or [],
        qualification=qualification,
        preview=preview,
        inline_email=True,
    )


def qualify_rows(job_rows: list[dict[str, Any]]) -> MonthlyQualification:
    total_sale = money(sum((r["sale"] for r in job_rows), ZERO))
    total_po = money(sum((r["cost"] for r in job_rows), ZERO))
    total_labour = money(sum((r.get("labour") or ZERO for r in job_rows), ZERO))
    total_profit = money(sum((r["profit"] for r in job_rows), ZERO))
    running = sum_job_commissions(job_rows)
    return qualify_month(
        total_sale,
        total_profit,
        running,
        total_labour=total_labour,
        total_po=total_po,
        job_profits=[r["profit"] for r in job_rows],
    )
