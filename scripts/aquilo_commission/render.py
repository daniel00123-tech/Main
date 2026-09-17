"""Email-safe HTML packs for Aquilo AM commission scorecards."""

from __future__ import annotations

import datetime as dt
import html
from typing import Any

from .commission import MonthlyQualification, qualify_month, sum_job_commissions
from .settings import COMPANY_NAME, LABOUR_RATE
from .util import format_margin, gbp, money

D = __import__("decimal").Decimal
ZERO = D("0")

QUIET = "color:#4a5560;font-size:10px;font-weight:400;"
HEAD = "background:#1f3a5f;color:#fff;"
TABLE_CSS = "border-collapse:collapse;font-size:12px;border-color:#ccc;width:100%;"
CELL = "padding:6px;border:1px solid #ccc;"


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
        f"<td width='16%' style='background:{bg};padding:8px 10px;color:#fff;vertical-align:top;'>"
        f"<div style='font-size:11px;line-height:1.2;'>{html.escape(label)}</div>"
        f"<div style='font-size:16px;font-weight:700;padding-top:4px;white-space:nowrap;'>{value}</div>"
        f"</td>"
    )


def render_qualification(q: MonthlyQualification) -> str:
    if q.qualified:
        status_bg, status_fg = "#d4edda", "#155724"
    else:
        status_bg, status_fg = "#fff3cd", "#856404"
    current_margin = format_margin(q.overall_margin)
    coach = ""
    if q.coach_line:
        coach = (
            f"<p style='margin:12px 0 0;font-size:13px;color:#333;'>{html.escape(q.coach_line)}</p>"
        )
    payable_note = (
        f"Payable commission: {gbp(q.payable_commission)}"
        if q.qualified
        else f"Running commission {gbp(q.running_commission)} is shown, but payable commission is £0.00 until unlocked."
    )
    return f"""
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border:1px solid #c5d0dc;background:#f7fafc;">
      <tr><td style="padding:14px 16px;">
        <p style="margin:0 0 8px;font-weight:700;color:#1f3a5f;">Monthly qualification</p>
        <p style="margin:0 0 4px;">Minimum profit {gbp(q.min_profit)} (no sales gate). Target margin {format_margin(q.min_margin_message)} is shown for coaching only and does not gate payment.</p>
        <p style="margin:0 0 4px;">Current profit {gbp(q.total_profit)}. Remaining {gbp(q.profit_remaining)}.</p>
        <p style="margin:0 0 8px;">{html.escape(payable_note)}</p>
        <p style="margin:0;padding:8px 10px;background:{status_bg};color:{status_fg};font-weight:700;display:inline-block;">
          STATUS: {html.escape(q.status)}
        </p>
        {coach}
      </td></tr>
    </table>
    """


def render_job_table(job_rows: list[dict[str, Any]]) -> str:
    body = []
    for row in job_rows:
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
    <table cellpadding="0" cellspacing="0" border="1" style="{TABLE_CSS}">
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
    <h2 style="color:#721c24;font-size:16px;margin:24px 0 8px;">Anomalies (excluded from totals and commission)</h2>
    <table cellpadding="0" cellspacing="0" border="1" style="{TABLE_CSS}">
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
    <h2 style="color:#856404;font-size:16px;margin:24px 0 8px;">Highlighted for review</h2>
    <table cellpadding="0" cellspacing="0" border="1" style="{TABLE_CSS}">
      <thead>
        <tr>
          {_th("Date")}{_th("Group/job")}{_th("Invoiced")}{_th("Profit")}{_th("Margin")}{_th("Flag")}
        </tr>
      </thead>
      <tbody>{''.join(body)}</tbody>
    </table>
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
    total_sale = qualification.total_revenue
    total_po = qualification.total_po
    total_labour = qualification.total_labour
    total_profit = qualification.total_profit
    total_margin = qualification.overall_margin
    commission = qualification.payable_commission
    preview_note = " Preview pack — not sent to the account manager." if preview else ""
    return f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>{html.escape(staff_name)} {html.escape(month_label)} Aquilo commission</title>
</head>
<body style="margin:0;padding:20px;background:#fff;font-family:Arial,Helvetica,sans-serif;color:#222;">
  <h1 style="color:#1f3a5f;margin:0 0 6px;">{html.escape(staff_name)} — {html.escape(COMPANY_NAME)} — {html.escape(month_label)}</h1>
  <p style="margin:0 0 16px;color:#4a5560;font-size:13px;">
    Payroll Labour uses planned hours at {gbp(LABOUR_RATE)}/h (not timesheets).
    Commission is one calculation per job group. Quotes are ignored.{preview_note}
  </p>
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">
    <tr>
      {_tile("Overall profit", gbp(total_profit), "#1f3a5f")}
      {_tile("Invoiced", gbp(total_sale), "#2e5a8f")}
      {_tile("Purchase orders", gbp(total_po), "#3d6fa3")}
      {_tile("Labour", gbp(total_labour), "#4a82b8")}
      {_tile("Margin", format_margin(total_margin), "#3b6d99")}
      {_tile("Commission", gbp(commission), "#1b7a4a")}
    </tr>
  </table>
  {render_qualification(qualification)}
  {render_job_table(job_rows) if job_rows else "<p>No qualifying groups in this month.</p>"}
  {render_anomaly_table(anomaly_rows)}
  {render_review_table(review_rows)}
</body>
</html>
"""


def build_email_body(
    *,
    staff_name: str,
    month_label: str,
    first_name: str,
    qualification: MonthlyQualification,
    job_count: int,
    preview: bool = True,
) -> str:
    """Compact scorecard for the email body. Full table goes in the attachment."""
    preview_line = "<p><em>This is a preview pack. It has not been sent to the account manager.</em></p>" if preview else ""
    return f"""
    <div style="font-family:Arial,Helvetica,sans-serif;color:#222;">
      <p>Hi {html.escape(first_name)},</p>
      <p>Please find your {html.escape(month_label)} {html.escape(COMPANY_NAME)} commission scorecard below.
      The full job table is attached so the email client cannot clip the larger packs.</p>
      {preview_line}
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0;">
        <tr>
          {_tile("Overall profit", gbp(qualification.total_profit), "#1f3a5f")}
          {_tile("Invoiced", gbp(qualification.total_revenue), "#2e5a8f")}
          {_tile("Purchase orders", gbp(qualification.total_po), "#3d6fa3")}
        </tr>
        <tr>
          {_tile("Labour", gbp(qualification.total_labour), "#4a82b8")}
          {_tile("Margin", format_margin(qualification.overall_margin), "#3b6d99")}
          {_tile("Commission", gbp(qualification.payable_commission), "#1b7a4a")}
        </tr>
      </table>
      {render_qualification(qualification)}
      <p style="font-size:13px;color:#4a5560;">Qualifying groups/jobs in the attached table: {job_count}.</p>
      <p>Kind regards,<br>Daniel Dwyer</p>
    </div>
    """


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
