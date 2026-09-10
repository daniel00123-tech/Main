#!/usr/bin/env python3
"""Monthly staff commission report. Read-only against BigChange.

Change only STAFF_NAME for another staff automation. Known category IDs stay
in KNOWN_CATEGORY_IDS so new staff reuse this engine.
"""

from __future__ import annotations

import datetime as dt
import decimal
import html
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any
from zoneinfo import ZoneInfo

try:
    from scripts.staff_profit_report import (
        ConfigError,
        JobWatchClient,
        RestClient,
        exact_margin,
        load_staff_rows,
        london_month_bounds,
        lookup_category_id,
        required_env,
    )
except ImportError:  # python scripts/staff_commission.py
    from staff_profit_report import (
        ConfigError,
        JobWatchClient,
        RestClient,
        exact_margin,
        load_staff_rows,
        london_month_bounds,
        lookup_category_id,
        required_env,
    )

# Change only this name for another staff automation.
STAFF_NAME = os.environ.get("STAFF_NAME", "Sharon")

KNOWN_CATEGORY_IDS = {
    "sharon": "132264",
    "ella": "132225",
    "lauren": "132263",
}

LONDON = ZoneInfo("Europe/London")
DECIMAL_ZERO = decimal.Decimal("0")
PENNY = decimal.Decimal("0.01")
COMMISSION_CAP = decimal.Decimal("250")
MIN_PROFIT = decimal.Decimal("8000")
MIN_MARGIN = decimal.Decimal("25")
FROM_EMAIL = "ella@elvexpropertyservices.com"
TO_EMAIL = "ella@elvexpropertyservices.com"
CC_EMAIL = "william@elvexpropertyservices.com"
TILE_COLOURS = ("#1f3a5f", "#2e5a8f", "#3d6fa3", "#4a82b8", "#1b7a4a")
TILE_LABELS = ("Overall profit", "Invoiced", "Purchase orders", "Margin", "Commission")


def money(value: decimal.Decimal) -> str:
    quantized = value.quantize(PENNY)
    if quantized < 0:
        return f"-£{abs(quantized):,.2f}"
    return f"£{quantized:,.2f}"


def money_signed(value: decimal.Decimal) -> str:
    quantized = value.quantize(PENNY)
    if quantized < 0:
        return f"-£{abs(quantized):,.2f}"
    return f"£{quantized:,.2f}"


def fmt_date(value: dt.date) -> str:
    return value.strftime("%d/%m/%Y")


def month_title(today: dt.date) -> str:
    return today.strftime("%B %Y")


def display_margin(margin: decimal.Decimal | None) -> str:
    if margin is None:
        return "n/a"
    return f"{margin.quantize(decimal.Decimal('0.1'))}%"


def margin_colour(margin: decimal.Decimal | None) -> str | None:
    if margin is None:
        return None
    if margin < decimal.Decimal("20"):
        return "#f4c7c3"
    if margin <= decimal.Decimal("34.9"):
        return "#ffe599"
    if margin > decimal.Decimal("45"):
        return "#b6d7a8"
    return None


def commission_colour(value: decimal.Decimal) -> str:
    if value > 0:
        return "#1b7a4a"
    if value < 0:
        return "#c0392b"
    return "#6b7280"


def _quantize(value: decimal.Decimal) -> decimal.Decimal:
    return value.quantize(PENNY)


def _capped_minus(value: decimal.Decimal) -> decimal.Decimal:
    return max(-COMMISSION_CAP, _quantize(value))


def job_commission(sale: decimal.Decimal, po: decimal.Decimal) -> decimal.Decimal:
    """Commission once per aggregated group. Uses exact margin, not 1dp display."""
    profit = sale - po
    if sale <= 0:
        if po > 0:
            return _capped_minus(-(po * decimal.Decimal("0.20")))
        return DECIMAL_ZERO

    margin = profit / sale * decimal.Decimal("100")

    if sale < decimal.Decimal("2000"):
        if margin < decimal.Decimal("20"):
            return _capped_minus(profit - sale * decimal.Decimal("0.20"))
        if margin < decimal.Decimal("30"):
            return DECIMAL_ZERO
        if margin < decimal.Decimal("42"):
            rate = decimal.Decimal("0.05")
        elif margin < decimal.Decimal("50"):
            rate = decimal.Decimal("0.075")
        else:
            rate = decimal.Decimal("0.10")
        return _quantize(profit * rate)

    if sale < decimal.Decimal("5000"):
        if margin < decimal.Decimal("12.5"):
            return _capped_minus(profit - sale * decimal.Decimal("0.125"))
        if margin < decimal.Decimal("35"):
            rate = decimal.Decimal("0.05")
        elif margin < decimal.Decimal("42.5"):
            rate = decimal.Decimal("0.075")
        else:
            rate = decimal.Decimal("0.10")
        return _quantize(profit * min(rate, decimal.Decimal("0.10")))

    if margin < decimal.Decimal("10"):
        return _capped_minus(profit - sale * decimal.Decimal("0.10"))
    if margin < decimal.Decimal("20"):
        rate = decimal.Decimal("0.05")
    elif margin < decimal.Decimal("32"):
        rate = decimal.Decimal("0.075")
    else:
        rate = decimal.Decimal("0.10")
    return _quantize(profit * min(rate, decimal.Decimal("0.10")))


def attach_commissions(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    enriched: list[dict[str, Any]] = []
    run_profit = DECIMAL_ZERO
    run_commission = DECIMAL_ZERO
    for row in rows:
        commission = job_commission(row["sale"], row["po"])
        run_profit += row["profit"]
        run_commission += commission
        enriched.append(
            {
                **row,
                "commission": commission,
                "run_profit": run_profit,
                "run_commission": run_commission,
            }
        )
    return enriched


def month_totals(rows: list[dict[str, Any]]) -> dict[str, Any]:
    sale = sum((row["sale"] for row in rows), DECIMAL_ZERO)
    po = sum((row["po"] for row in rows), DECIMAL_ZERO)
    profit = sum((row["profit"] for row in rows), DECIMAL_ZERO)
    commission = sum((row["commission"] for row in rows), DECIMAL_ZERO)
    return {
        "sale": sale,
        "po": po,
        "profit": profit,
        "commission": commission,
        "margin": exact_margin(sale, profit),
        "count": len(rows),
    }


def is_qualified(totals: dict[str, Any]) -> bool:
    margin = totals["margin"]
    return totals["profit"] >= MIN_PROFIT and margin is not None and margin >= MIN_MARGIN


def resolve_category_id(staff_name: str, rest: RestClient, jobwatch: JobWatchClient) -> str:
    known = KNOWN_CATEGORY_IDS.get(staff_name.strip().lower())
    if known:
        return known
    return lookup_category_id(staff_name, rest, jobwatch)


def _cell(text: str, extra: str = "", align: str = "left") -> str:
    return (
        f'<td style="padding:7px 8px;border:1px solid #c5cdd6;text-align:{align};'
        f'color:#111;{extra}">{html.escape(text)}</td>'
    )


def _run_cell(text: str) -> str:
    return (
        '<td style="padding:7px 8px;border:1px solid #c5cdd6;border-left:2px solid #4a5560;'
        'text-align:right;font-size:10px;color:#4a5560;white-space:nowrap;">'
        f"{html.escape(text)}</td>"
    )


def _scorecard(totals: dict[str, Any]) -> str:
    """One coloured tile per metric. Label row then figure row, stacked so
    mobile clients cannot squeeze five nowrap amounts onto one overlapping line.
    """
    figures = (
        money(totals["profit"]),
        money(totals["sale"]),
        money(totals["po"]),
        display_margin(totals["margin"]),
        money_signed(totals["commission"]),
    )
    tiles = []
    for colour, label, figure in zip(TILE_COLOURS, TILE_LABELS, figures):
        tiles.append(
            "<tr>"
            f'<td style="background:{colour};padding:0;border:0;">'
            '<table width="100%" cellpadding="0" cellspacing="0" '
            'style="border-collapse:collapse;width:100%;">'
            "<tr>"
            f'<td style="background:{colour};color:#ffffff;padding:10px 12px 2px 12px;'
            f'font-size:12px;font-weight:bold;line-height:16px;">{html.escape(label)}</td>'
            "</tr>"
            "<tr>"
            f'<td style="background:{colour};color:#ffffff;padding:2px 12px 12px 12px;'
            f'font-size:20px;font-weight:bold;line-height:24px;white-space:nowrap;">'
            f"{html.escape(figure)}</td>"
            "</tr>"
            "</table>"
            "</td>"
            "</tr>"
        )
    return (
        '<table width="100%" cellpadding="0" cellspacing="0" '
        'style="border-collapse:collapse;width:100%;">'
        f"{''.join(tiles)}</table>"
    )


def _qual_row(label: str, value: str) -> str:
    return (
        "<tr>"
        f'<td style="padding:6px 10px;border-bottom:1px solid #e3e8ef;color:#222;">{html.escape(label)}</td>'
        f'<td style="padding:6px 10px;border-bottom:1px solid #e3e8ef;width:160px;white-space:nowrap;'
        f'text-align:right;color:#111;">{html.escape(value)}</td>'
        "</tr>"
    )


def _qualification_box(totals: dict[str, Any]) -> str:
    qualified = is_qualified(totals)
    remaining = max(DECIMAL_ZERO, MIN_PROFIT - totals["profit"])
    status = "COMMISSION QUALIFIED" if qualified else "NOT YET QUALIFIED"
    badge_bg = "#1b7a4a" if qualified else "#c27c0e"
    rows = [
        _qual_row("Total revenue", money(totals["sale"])),
        _qual_row("Total profit", money(totals["profit"])),
        _qual_row("Overall margin", display_margin(totals["margin"])),
        _qual_row("Commission", money_signed(totals["commission"])),
        _qual_row("Minimum profit required", money(MIN_PROFIT)),
        _qual_row("Current profit", money(totals["profit"])),
        _qual_row("Remaining", money(remaining)),
        _qual_row("Minimum margin required", "25%"),
        _qual_row("Current margin", display_margin(totals["margin"])),
    ]
    earned = ""
    if qualified:
        earned = (
            '<tr><td colspan="2" style="padding:10px;color:#1b7a4a;font-weight:bold;">'
            f"Commission Earned: {html.escape(money_signed(totals['commission']))}</td></tr>"
        )
    return (
        '<table width="100%" cellpadding="0" cellspacing="0" '
        'style="border-collapse:collapse;width:100%;margin-top:16px;border:1px solid #d0d7de;background:#f8fafc;">'
        f"{''.join(rows)}"
        '<tr><td colspan="2" style="padding:12px 10px;text-align:center;">'
        f'<span style="background:{badge_bg};color:#ffffff;padding:6px 14px;'
        f'font-weight:bold;">{html.escape(status).replace(" ", "&nbsp;")}</span></td></tr>'
        f"{earned}"
        "</table>"
    )


def _job_row(row: dict[str, Any]) -> str:
    colour = margin_colour(row["margin"])
    margin_style = f"background-color:{colour};" if colour else ""
    comm_colour = commission_colour(row["commission"])
    return (
        "<tr>"
        + _cell(fmt_date(row["date"]), "font-weight:bold;")
        + _cell(row["label"], "font-weight:bold;")
        + _cell(money(row["sale"]), "white-space:nowrap;", "right")
        + _cell(money(row["po"]), "white-space:nowrap;", "right")
        + _cell(money(row["profit"]), "white-space:nowrap;", "right")
        + _cell(display_margin(row["margin"]), f"{margin_style}white-space:nowrap;", "right")
        + _cell(
            money_signed(row["commission"]),
            f"color:{comm_colour};font-weight:bold;white-space:nowrap;",
            "right",
        )
        + _run_cell(money(row["run_profit"]))
        + _run_cell(money_signed(row["run_commission"]))
        + "</tr>"
    )


def _day_subtotal(date: dt.date, day_rows: list[dict[str, Any]]) -> str:
    sale = sum((row["sale"] for row in day_rows), DECIMAL_ZERO)
    po = sum((row["po"] for row in day_rows), DECIMAL_ZERO)
    profit = sum((row["profit"] for row in day_rows), DECIMAL_ZERO)
    commission = sum((row["commission"] for row in day_rows), DECIMAL_ZERO)
    last = day_rows[-1]
    margin = exact_margin(sale, profit)
    extra = "background:#eef2f6;font-weight:bold;"
    return (
        "<tr>"
        + _cell(fmt_date(date), extra)
        + _cell("Day total", extra)
        + _cell(money(sale), f"{extra}white-space:nowrap;", "right")
        + _cell(money(po), f"{extra}white-space:nowrap;", "right")
        + _cell(money(profit), f"{extra}white-space:nowrap;", "right")
        + _cell(display_margin(margin), f"{extra}white-space:nowrap;", "right")
        + _cell(money_signed(commission), f"{extra}white-space:nowrap;", "right")
        + _run_cell(money(last["run_profit"]))
        + _run_cell(money_signed(last["run_commission"]))
        + "</tr>"
    )


def _jobs_table(rows: list[dict[str, Any]], totals: dict[str, Any]) -> str:
    header = (
        '<tr style="background:#1f3a5f;color:#ffffff;">'
        '<th style="padding:8px;border:1px solid #1f3a5f;text-align:left;">Date</th>'
        '<th style="padding:8px;border:1px solid #1f3a5f;text-align:left;">Group / job</th>'
        '<th style="padding:8px;border:1px solid #1f3a5f;text-align:right;">Invoiced</th>'
        '<th style="padding:8px;border:1px solid #1f3a5f;text-align:right;">Purchase orders</th>'
        '<th style="padding:8px;border:1px solid #1f3a5f;text-align:right;">Profit</th>'
        '<th style="padding:8px;border:1px solid #1f3a5f;text-align:right;">Margin</th>'
        '<th style="padding:8px;border:1px solid #1f3a5f;text-align:right;">Commission</th>'
        '<th style="padding:8px;border:1px solid #1f3a5f;border-left:2px solid #4a5560;text-align:right;font-size:10px;">Run profit</th>'
        '<th style="padding:8px;border:1px solid #1f3a5f;text-align:right;font-size:10px;">Run comm.</th>'
        "</tr>"
    )
    body: list[str] = []
    if not rows:
        body.append(
            '<tr><td colspan="9" style="padding:8px;border:1px solid #c5cdd6;">No completed groups invoiced this month.</td></tr>'
        )
    else:
        current_date = rows[0]["date"]
        day_rows: list[dict[str, Any]] = []
        for row in rows:
            if row["date"] != current_date:
                body.append(_day_subtotal(current_date, day_rows))
                current_date = row["date"]
                day_rows = []
            body.append(_job_row(row))
            day_rows.append(row)
        body.append(_day_subtotal(current_date, day_rows))
    footer = (
        '<tr style="background:#1f3a5f;color:#ffffff;font-weight:bold;">'
        f'<td colspan="2" style="padding:8px;border:1px solid #1f3a5f;">Total — {totals["count"]} groups/jobs</td>'
        f'<td style="padding:8px;border:1px solid #1f3a5f;text-align:right;white-space:nowrap;">{html.escape(money(totals["sale"]))}</td>'
        f'<td style="padding:8px;border:1px solid #1f3a5f;text-align:right;white-space:nowrap;">{html.escape(money(totals["po"]))}</td>'
        f'<td style="padding:8px;border:1px solid #1f3a5f;text-align:right;white-space:nowrap;">{html.escape(money(totals["profit"]))}</td>'
        f'<td style="padding:8px;border:1px solid #1f3a5f;text-align:right;white-space:nowrap;">{html.escape(display_margin(totals["margin"]))}</td>'
        f'<td style="padding:8px;border:1px solid #1f3a5f;text-align:right;white-space:nowrap;">{html.escape(money_signed(totals["commission"]))}</td>'
        f'<td style="padding:8px;border:1px solid #1f3a5f;border-left:2px solid #4a5560;text-align:right;font-size:10px;white-space:nowrap;">{html.escape(money(totals["profit"]))}</td>'
        f'<td style="padding:8px;border:1px solid #1f3a5f;text-align:right;font-size:10px;white-space:nowrap;">{html.escape(money_signed(totals["commission"]))}</td>'
        "</tr>"
    )
    return (
        '<table width="100%" cellpadding="0" cellspacing="0" '
        'style="border-collapse:collapse;width:100%;margin-top:16px;">'
        f"<thead>{header}</thead><tbody>{''.join(body)}</tbody><tfoot>{footer}</tfoot></table>"
    )


def _anomalies_table(anomalies: list[dict[str, Any]]) -> str:
    if not anomalies:
        return ""
    rows = []
    for row in anomalies:
        colour = margin_colour(row["margin"])
        margin_style = f"background-color:{colour};" if colour else ""
        rows.append(
            "<tr>"
            + _cell(fmt_date(row["date"]), "font-weight:bold;")
            + _cell(row["label"], "font-weight:bold;")
            + _cell(money(row["sale"]), "white-space:nowrap;", "right")
            + _cell(money(row["po"]), "white-space:nowrap;", "right")
            + _cell(money(row["profit"]), "white-space:nowrap;", "right")
            + _cell(display_margin(row["margin"]), f"{margin_style}white-space:nowrap;", "right")
            + "</tr>"
        )
    return (
        '<h2 style="font-family:Arial,Helvetica,sans-serif;font-size:16px;margin:20px 0 8px 0;">Anomalies</h2>'
        '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;">'
        '<thead><tr style="background:#1f3a5f;color:#ffffff;">'
        '<th style="padding:8px;border:1px solid #1f3a5f;text-align:left;">Date</th>'
        '<th style="padding:8px;border:1px solid #1f3a5f;text-align:left;">Group / job</th>'
        '<th style="padding:8px;border:1px solid #1f3a5f;text-align:right;">Invoiced</th>'
        '<th style="padding:8px;border:1px solid #1f3a5f;text-align:right;">Purchase orders</th>'
        '<th style="padding:8px;border:1px solid #1f3a5f;text-align:right;">Profit</th>'
        '<th style="padding:8px;border:1px solid #1f3a5f;text-align:right;">Margin</th>'
        "</tr></thead>"
        f"<tbody>{''.join(rows)}</tbody></table>"
    )


def build_html(staff_name: str, month_label: str, rows: list[dict[str, Any]], anomalies: list[dict[str, Any]]) -> str:
    totals = month_totals(rows)
    title = (
        f"{html.escape(staff_name)} — {html.escape(month_label)}"
        "<br>commission report"
    )
    return f"""<!DOCTYPE html>
<html>
<body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;margin:0;padding:12px;">
<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin:0 0 16px 0;">
<tr>
<td style="font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:26px;font-weight:bold;color:#111;padding:0 0 4px 0;">
{title}
</td>
</tr>
</table>
{_scorecard(totals)}
{_qualification_box(totals)}
{_jobs_table(rows, totals)}
{_anomalies_table(anomalies)}
</body>
</html>
"""


def graph_token() -> str:
    tenant = (
        os.environ.get("MS_TENANT_ID")
        or os.environ.get("MICROSOFT_TENANT_ID")
        or os.environ.get("GRAPH_TENANT_ID")
        or required_env("MS_TENANT_ID")
    )
    client_id = (
        os.environ.get("MS_CLIENT_ID")
        or os.environ.get("MICROSOFT_CLIENT_ID")
        or os.environ.get("GRAPH_CLIENT_ID")
        or required_env("MS_CLIENT_ID")
    )
    client_secret = (
        os.environ.get("MS_CLIENT_SECRET")
        or os.environ.get("MICROSOFT_CLIENT_SECRET")
        or os.environ.get("GRAPH_CLIENT_SECRET")
        or required_env("MS_CLIENT_SECRET")
    )
    body = urllib.parse.urlencode(
        {
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
            "scope": "https://graph.microsoft.com/.default",
        }
    ).encode()
    req = urllib.request.Request(
        f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    token = payload.get("access_token")
    if not token:
        raise RuntimeError("Microsoft Graph token response had no access_token")
    return token


def send_graph_mail(subject: str, html_body: str) -> None:
    token = graph_token()
    message = {
        "message": {
            "subject": subject,
            "body": {"contentType": "HTML", "content": html_body},
            "from": {"emailAddress": {"address": FROM_EMAIL}},
            "toRecipients": [{"emailAddress": {"address": TO_EMAIL}}],
            "ccRecipients": [{"emailAddress": {"address": CC_EMAIL}}],
        },
        "saveToSentItems": True,
    }
    data = json.dumps(message).encode("utf-8")
    req = urllib.request.Request(
        f"https://graph.microsoft.com/v1.0/users/{urllib.parse.quote(FROM_EMAIL)}/sendMail",
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            response.read()
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Graph sendMail HTTP {exc.code}") from None


def send_with_retry(subject: str, html_body: str) -> None:
    try:
        send_graph_mail(subject, html_body)
    except Exception:
        time.sleep(2)
        send_graph_mail(subject, html_body)


def build_report(staff_name: str, today: dt.date) -> tuple[str, str, dict[str, Any]]:
    rest = RestClient()
    jobwatch = JobWatchClient()
    category_id = resolve_category_id(staff_name, rest, jobwatch)
    raw_rows, anomalies = load_staff_rows(staff_name, category_id, today, rest, jobwatch)
    rows = attach_commissions(raw_rows)
    month_label = month_title(today)
    html_body = build_html(staff_name, month_label, rows, anomalies)
    totals = month_totals(rows)
    subject = f"{staff_name} — {month_label} — commission report"
    summary = {
        "staff": staff_name,
        "category_id": category_id,
        "month": month_label,
        "month_start": london_month_bounds(today)[0].isoformat(),
        "count": totals["count"],
        "anomalies": len(anomalies),
        "sale": str(totals["sale"]),
        "po": str(totals["po"]),
        "profit": str(totals["profit"]),
        "commission": str(totals["commission"]),
        "qualified": is_qualified(totals),
    }
    return subject, html_body, summary


def main() -> int:
    now = dt.datetime.now(LONDON)
    today = now.date()
    staff_name = STAFF_NAME.strip() or "Sharon"
    try:
        subject, html_body, summary = build_report(staff_name, today)
        if os.environ.get("DRY_RUN", "").strip().lower() in {"1", "true", "yes"}:
            print(json.dumps(summary, indent=2))
            return 0
        send_with_retry(subject, html_body)
        print(
            "SENT staff={staff} month={month} groups={count} profit={profit} "
            "commission={commission} qualified={qualified}".format(**summary)
        )
        return 0
    except ConfigError as exc:
        print(f"CONFIG_ERROR: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
