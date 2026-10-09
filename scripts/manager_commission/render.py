"""Compact HTML manager scorecard. The full report is the email body."""

from __future__ import annotations

import html
from typing import Any

from scripts.nirvana_commission.render import grokbot_src

from .models import AttentionItem, ManagerReport, NegativeJob, StaffLine
from .money import D, ZERO, format_margin, gbp, gbp_whole

NAVY = "#1f3a5f"
CELL = "padding:7px 8px;border:1px solid #d5dde6;font-size:12px;line-height:1.35;"
HEAD = "background:#1f3a5f;color:#ffffff;font-weight:700;"
TABLE = "border-collapse:collapse;width:100%;"


def _esc(value: Any) -> str:
    return html.escape(str(value), quote=True)


def _td(text: str, extra: str = "", align: str = "left") -> str:
    return f"<td style='{CELL}text-align:{align};{extra}'>{text}</td>"


def _th(label: str) -> str:
    return f"<th style='{CELL}{HEAD}text-align:left;'>{_esc(label)}</th>"


def _money(value: D, extra: str = "") -> str:
    colour = ""
    if value < 0:
        colour = "color:#721c24;font-weight:700;"
    elif value > 0:
        colour = "color:#155724;font-weight:700;"
    return _td(gbp(value), colour + extra, align="right")


def _margin_cell(margin: D | None) -> str:
    style = ""
    if margin is not None:
        if margin < D("20"):
            style = "background:#f8d7da;color:#721c24;font-weight:700;"
        elif margin < D("35"):
            style = "background:#fff3cd;color:#856404;font-weight:700;"
    return _td(format_margin(margin), style, align="right")


def _tile(label: str, value: str, bg: str) -> str:
    return (
        f"<td width='32%' bgcolor='{bg}' style='background:{bg};padding:14px 12px;"
        f"color:#ffffff;vertical-align:top;'>"
        f"<p style='margin:0 0 6px;font-size:11px;letter-spacing:0.03em;'>{_esc(label)}</p>"
        f"<p style='margin:0;font-size:18px;line-height:1.3;font-weight:700;'>{_esc(value)}</p>"
        f"</td>"
    )


def _gutter() -> str:
    return "<td width='8' style='width:8px;font-size:8px;line-height:8px;'>&nbsp;</td>"


def _status_cell(line: StaffLine) -> str:
    colour = "#155724" if line.qualified else "#856404"
    return _td(
        f"<span style='font-weight:700;color:{colour};'>{_esc(line.status)}</span>"
        f"<br><span style='color:#5b6775;font-size:11px;'>{_esc(gbp_whole(line.profit_gate))} threshold</span>"
    )


def _staff_row(line: StaffLine) -> str:
    return (
        "<tr>"
        + _td(_esc(line.name), "font-weight:700;")
        + _money(line.sales, "font-weight:400;color:#1a2433;")
        + _money(line.profit, "font-weight:400;color:#1a2433;")
        + _margin_cell(line.margin)
        + _money(line.net_running_commission)
        + _status_cell(line)
        + _money(line.contribution)
        + "</tr>"
    )


def _total_row(label: str, sales: D, profit: D, commission: D, contribution: D, margin: D | None) -> str:
    strong = "font-weight:700;background:#eef3f8;"
    return (
        "<tr>"
        + _td(_esc(label), strong)
        + _td(gbp(sales), strong, align="right")
        + _td(gbp(profit), strong, align="right")
        + _td(format_margin(margin), strong, align="right")
        + _td(gbp(commission), strong, align="right")
        + _td("", strong)
        + _td(gbp(contribution), strong, align="right")
        + "</tr>"
    )


def _negative_row(row: NegativeJob) -> str:
    treatment = ""
    if row.treatment:
        treatment = f"<br><span style='color:#856404;font-size:11px;'>{_esc(row.treatment)}</span>"
    return (
        "<tr>"
        + _td(_esc(row.owner))
        + _td(f"{_esc(row.reference)}{treatment}")
        + _money(row.sale, "font-weight:400;color:#1a2433;")
        + _money(row.po, "font-weight:400;color:#1a2433;")
        + _money(row.labour, "font-weight:400;color:#1a2433;")
        + _money(row.profit, "font-weight:400;color:#1a2433;")
        + _margin_cell(row.margin)
        + _money(row.staff_commission)
        + _money(row.manager_impact)
        + "</tr>"
    )


def _attention_row(item: AttentionItem) -> str:
    profit = "n/a" if item.profit is None else gbp(item.profit)
    return (
        "<tr>"
        + _td(_esc(item.reference))
        + _td(_esc(item.owner or "Unallocated"))
        + _money(item.sale, "font-weight:400;color:#1a2433;")
        + _td(profit, align="right")
        + _td(_esc(item.reason))
        + "</tr>"
    )


def _kv(label: str, value: str) -> str:
    return (
        "<tr>"
        f"<td style='padding:7px 0;color:#5b6775;font-size:14px;'>{_esc(label)}</td>"
        f"<td style='padding:7px 0;text-align:right;font-weight:700;font-size:14px;color:#1a2433;'>{value}</td>"
        "</tr>"
    )


def render_email(report: ManagerReport, *, inline_email: bool = True) -> str:
    rate_label = f"{(report.rate * D('100')).quantize(D('1')):f}%"
    icon = grokbot_src(inline_email=inline_email)
    status_bg = "#1b7a4a" if report.manager_qualified else "#8a5a00"
    payable_bg = "#1b7a4a" if report.payable_bonus > 0 else "#1f3a5f"
    preview = ""
    if report.delivery_mode != "approved":
        preview = (
            "<p style='margin:0 0 16px;padding:10px 12px;background:#fff3cd;color:#856404;"
            "font-size:13px;line-height:1.45;'>"
            "Preview only. This scorecard has not been emailed."
            "</p>"
        )
    staff_margin = None
    if report.staff_sales != 0:
        staff_margin = report.staff_profit / report.staff_sales * D("100")
    misc_commission = "No commission"
    remaining_row = ""
    if report.remaining_profit > 0:
        remaining_row = _kv("Remaining profit needed", gbp(report.remaining_profit))
    negative_body = "".join(_negative_row(row) for row in report.negative_jobs)
    if not report.negative_jobs:
        negative_section = (
            "<p style='margin:0 0 22px;font-size:14px;color:#243040;'>"
            "No negative commission jobs this month."
            "</p>"
        )
    else:
        negative_section = f"""
        <p style="margin:0 0 10px;font-size:14px;line-height:1.5;color:#243040;">
          Every completed job group with negative staff commission is listed.
          That deduction is already inside the person's net running commission and in the manager contribution above. It is not applied again.
        </p>
        <table cellpadding="0" cellspacing="0" border="1" style="{TABLE}margin:0 0 8px;">
          <thead><tr>
            {_th("Account Manager")}{_th("Group Reference")}{_th("Invoice Net ex VAT")}
            {_th("Purchase Orders")}{_th("Labour Cost")}{_th("Profit")}{_th("Profit Margin")}
            {_th("Staff Negative Commission")}{_th(f"Manager {rate_label} Impact")}
          </tr></thead>
          <tbody>
            {negative_body}
            <tr>
              {_td("Total", "font-weight:700;background:#f8d7da;")}
              {_td("", "background:#f8d7da;")}
              {_td("", "background:#f8d7da;")}{_td("", "background:#f8d7da;")}
              {_td("", "background:#f8d7da;")}{_td("", "background:#f8d7da;")}{_td("", "background:#f8d7da;")}
              {_td(gbp(report.negative_staff_total), "font-weight:700;background:#f8d7da;", align="right")}
              {_td(gbp(report.negative_manager_total), "font-weight:700;background:#f8d7da;", align="right")}
            </tr>
          </tbody>
        </table>
        """
    if report.priorities:
        items = "".join(
            f"<li style='margin:0 0 8px;'>{_esc(text)}</li>" for text in report.priorities
        )
        priority_section = f"<ol style='margin:0 0 8px;padding-left:20px;font-size:14px;line-height:1.5;color:#243040;'>{items}</ol>"
    else:
        priority_section = "<p style='margin:0;font-size:14px;color:#243040;'>No management priorities from this month's figures.</p>"
    notes = ""
    if report.notes:
        note_items = "".join(f"<li style='margin:0 0 6px;'>{_esc(note)}</li>" for note in report.notes)
        notes = f"<ul style='margin:16px 0 0;padding-left:18px;color:#5b6775;font-size:12px;line-height:1.45;'>{note_items}</ul>"
    misc_count = len(report.miscellaneous_group_ids)
    misc_audit = (
        f"{misc_count} completed group{'s' if misc_count != 1 else ''} "
        f"{'are' if misc_count != 1 else 'is'} unallocated. "
        "They are included in company profit and earn no commission. "
        "Group references are kept on the internal audit."
        if misc_count
        else "No unallocated groups this month. No commission is earned on this row."
    )
    salary_note = ""
    if report.running_bonus < 0:
        salary_note = (
            "<p style='margin:8px 0 0;font-size:13px;line-height:1.45;color:#243040;'>"
            "A negative balance stays inside this variable bonus. It is not taken from salary."
            "</p>"
        )
    elif not report.manager_qualified and report.running_bonus > 0:
        salary_note = (
            "<p style='margin:8px 0 0;font-size:13px;line-height:1.45;color:#243040;'>"
            f"Company gross profit is {gbp(report.company_profit)}. "
            f"The {gbp_whole(report.profit_gate)} profit level is not met, so the payable bonus is £0.00. "
            f"The provisional running bonus of {gbp(report.running_bonus)} is not payable this month."
            "</p>"
        )
    return f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Grokbot Manager Scorecard {_esc(report.heading)} {_esc(report.month_label)}</title>
</head>
<body style="margin:0;padding:0;background:#e8eef5;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#e8eef5;">
    <tr>
      <td align="center" style="padding:20px 10px;">
        <table width="760" cellpadding="0" cellspacing="0" border="0" style="width:760px;max-width:760px;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#243040;">
          <tr>
            <td style="padding:24px 22px 28px;">
              {preview}
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;">
                <tr>
                  <td bgcolor="{NAVY}" style="background:{NAVY};padding:16px 18px;">
                    <table cellpadding="0" cellspacing="0" border="0"><tr>
                      <td style="padding-right:12px;"><img src="{_esc(icon)}" width="52" height="52" alt="Grokbot" style="display:block;border:0;width:52px;height:52px;"></td>
                      <td>
                        <p style="margin:0 0 4px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#d7e3f2;">Grokbot Manager Scorecard</p>
                        <p style="margin:0 0 3px;font-size:20px;font-weight:700;color:#ffffff;">{_esc(report.heading)}</p>
                        <p style="margin:0;font-size:14px;color:#d7e3f2;">{_esc(report.month_label)} · {_esc(report.timezone)}</p>
                      </td>
                    </tr></table>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:#243040;">
                Month-to-date period: {_esc(report.period_label)}.<br>
                Reporting period: {_esc(report.period_id)}.
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;">
                <tr>
                  {_tile("Team sales", gbp(report.company_sales), "#1f3a5f")}
                  {_gutter()}
                  {_tile("Team gross profit", gbp(report.company_profit), "#2e5a8f")}
                  {_gutter()}
                  {_tile("Overall team profit margin", format_margin(report.company_margin), "#3d6fa3")}
                </tr>
              </table>
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;">
                <tr>
                  {_tile("Account managers qualified", f"{report.qualified_count} of {report.team_size}", "#3b6d99")}
                  {_gutter()}
                  {_tile("Estimated manager running bonus", gbp(report.running_bonus), "#4a82b8")}
                  {_gutter()}
                  {_tile("Manager payable bonus", gbp(report.payable_bonus), payable_bg)}
                </tr>
              </table>
              <p style="margin:0 0 8px;font-size:12px;line-height:1.45;color:#5b6775;">
                Team sales and gross profit include unallocated work. That work counts towards the profit level and earns no commission.
              </p>
              <p style="margin:0 0 18px;padding:10px 12px;background:{status_bg};color:#ffffff;font-size:14px;line-height:1.45;">
                Manager qualification: <strong>{_esc(report.manager_status)}</strong>
                against {gbp_whole(report.profit_gate)} gross profit.
              </p>

              <p style="margin:0 0 8px;font-size:18px;font-weight:700;color:{NAVY};">Staff performance</p>
              <table cellpadding="0" cellspacing="0" border="1" style="{TABLE}margin:0 0 8px;">
                <thead><tr>
                  {_th("Account Manager")}{_th("Sales")}{_th("Profit")}{_th("Margin")}
                  {_th("Net Running Commission")}{_th("Qualification Status")}
                  {_th(f"Manager {rate_label} Contribution")}
                </tr></thead>
                <tbody>
                  {''.join(_staff_row(line) for line in report.staff_lines)}
                  {_total_row("TOTAL", report.staff_sales, report.staff_profit, report.staff_commission, report.staff_contribution, staff_margin)}
                  <tr>
                    {_td("Miscellaneous / Unallocated", "font-weight:700;")}
                    {_td(gbp(report.miscellaneous_sales), align="right")}
                    {_td(gbp(report.miscellaneous_profit), align="right")}
                    {_td(format_margin(report.miscellaneous_margin), align="right")}
                    {_td(misc_commission)}
                    {_td("—")}
                    {_td(misc_commission)}
                  </tr>
                  {_total_row("COMPANY TOTAL", report.company_sales, report.company_profit, report.staff_commission, report.staff_contribution, report.company_margin)}
                </tbody>
              </table>
              <p style="margin:0 0 22px;font-size:12px;line-height:1.45;color:#5b6775;">{_esc(misc_audit)}</p>

              <p style="margin:0 0 8px;font-size:18px;font-weight:700;color:#721c24;">Negative jobs for management review</p>
              {negative_section}

              <p style="margin:0 0 8px;font-size:18px;font-weight:700;color:{NAVY};">Manager bonus reconciliation</p>
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;">
                {_kv("Staff net running commission", gbp(report.staff_commission))}
                {_kv(f"Manager {rate_label} share", gbp(report.reconciliation.manager_share))}
                {_kv("Manager monthly gross profit", gbp(report.reconciliation.company_profit))}
                {_kv("Required gross profit", gbp_whole(report.reconciliation.required_profit))}
                {remaining_row}
                {_kv("Manager status", _esc(report.reconciliation.status))}
                {_kv("Manager provisional running bonus", gbp(report.reconciliation.running_bonus))}
                {_kv("Manager payable bonus", gbp(report.reconciliation.payable_bonus))}
              </table>
              {salary_note}

              <p style="margin:22px 0 8px;font-size:18px;font-weight:700;color:{NAVY};">Grokbot management priorities</p>
              {priority_section}
              {notes}
              <p style="margin:18px 0 0;font-size:12px;color:#5b6775;">Period {_esc(report.period_id)}. {_esc(report.heading)}.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
"""


def assert_scorecard_html(report_html: str) -> None:
    lowered = report_html.lower()
    if "see attached" in lowered:
        raise ValueError("Manager scorecard must be in the email body")
    if "37.50" in report_html or "api_key" in lowered or "services.ashx" in lowered:
        raise ValueError("Manager scorecard exposes internal calculation or credential detail")
    for banned in (">Short<", ">Met<", "status: short", "status: met"):
        if banned.lower() in lowered:
            raise ValueError("Qualification status must be Qualified or Not qualified")
