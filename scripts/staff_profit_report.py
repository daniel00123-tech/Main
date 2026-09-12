#!/usr/bin/env python3
"""Staff profit report with job-level commission and a monthly qualification gate.

Read-only against BigChange. Existing sale / PO / profit / margin maths are unchanged.
Commission is calculated once per aggregated Group / Job, never on invoice lines
or on date / month subtotal rows.
"""

from __future__ import annotations

import argparse
import base64
import calendar
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
from collections import defaultdict
from typing import Any
from zoneinfo import ZoneInfo

try:
    from scripts.staff_commission import (
        attach_job_commissions,
        gbp,
        money,
        qualify_month,
        sum_job_commissions,
    )
except ImportError:  # python3 scripts/staff_profit_report.py
    from staff_commission import (  # type: ignore
        attach_job_commissions,
        gbp,
        money,
        qualify_month,
        sum_job_commissions,
    )


D = decimal.Decimal
ZERO = D("0")
LONDON = ZoneInfo("Europe/London")

# Change only this name (or STAFF_NAME) for another staff automation.
STAFF_NAME = os.environ.get("STAFF_NAME", "Sharon")

STAFF = {
    "sharon": {"name": "Sharon", "category_id": 132264},
    "ella": {"name": "Ella", "category_id": 132225},
    "lauren": {"name": "Lauren", "category_id": 132263},
}

FROM_EMAIL = "ella@elvexpropertyservices.com"
DEFAULT_MAIL_TO = "ella@elvexpropertyservices.com"
DEFAULT_MAIL_CC = "william@elvexpropertyservices.com"

COMPLETED = {"completedOk", "completedWithIssues"}
ANOMALY_SALE = D("250")
MIN_PO_AMOUNT = D("1")
BEGINNING_OF_TIME = dt.date(2026, 5, 1)


def is_missing_po_anomaly(sale: D, po_cost: D) -> bool:
    """Sale over £250 with no PO of £1+ on the completed group."""
    return sale > ANOMALY_SALE and abs(po_cost) < MIN_PO_AMOUNT


def live_jobs(members: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [m for m in members if (m.get("status") or "") != "cancelled"]


def group_fully_invoiced(members: list[dict[str, Any]], invoiced_job_ids: set[int]) -> bool:
    """True when every live job in the group has at least one invoice or credit."""
    live = live_jobs(members)
    if not live:
        return False
    return all(int(m["id"]) in invoiced_job_ids for m in live)


def group_all_jobs_completed(members: list[dict[str, Any]]) -> bool:
    """True when every live job is completed (not scheduled, open, or future)."""
    live = live_jobs(members)
    if not live:
        return False
    return all((m.get("status") or "") in COMPLETED for m in live)


def group_ready_to_report(members: list[dict[str, Any]]) -> bool:
    """A group is reported only after every live job is completed.

    Open or future jobs (scheduled, in progress, unscheduled, new) hold the group
    back. A later invoice still controls which month it appears in. Follow-on jobs
    that are purchase-order only do not have to be invoiced themselves.
    """
    return group_all_jobs_completed(members)


class ConfigError(RuntimeError):
    pass


def required_env(name: str) -> str:
    value = os.environ.get(name)
    if value is None or value == "":
        raise ConfigError(f"Missing required environment variable: {name}")
    return value


def as_dec(value: Any) -> D:
    if value in (None, ""):
        return ZERO
    try:
        return D(str(value))
    except (decimal.InvalidOperation, ValueError):
        return ZERO


def london_date_from_iso(value: Any) -> dt.date | None:
    if not value:
        return None
    text = str(value).strip().replace("Z", "+00:00")
    try:
        parsed = dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(LONDON).date()


def rest_token() -> str:
    client_id = (
        os.environ.get("BIGCHANGE_REST_CLIENT_ID")
        or os.environ.get("BIGCHANGE_CLIENT_ID")
        or os.environ.get("BC_REST_CLIENT_ID")
    )
    client_secret = (
        os.environ.get("BIGCHANGE_REST_CLIENT_SECRET")
        or os.environ.get("BIGCHANGE_CLIENT_SECRET")
        or os.environ.get("BC_REST_CLIENT_SECRET")
    )
    if not client_id or not client_secret:
        raise ConfigError("Missing BigChange REST client credentials")
    data = urllib.parse.urlencode(
        {
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
        }
    ).encode()
    req = urllib.request.Request("https://api.bigchange.com/auth/tokens", data=data, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)["access_token"]


def rest_get(token: str, path: str) -> Any:
    customer_id = os.environ.get("BIGCHANGE_CUSTOMER_ID", "5702")
    req = urllib.request.Request(f"https://api.bigchange.com{path}")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Customer-Id", customer_id)
    req.add_header("Accept", "application/json")
    with urllib.request.urlopen(req, timeout=90) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else None


def legacy(action: str, params: dict[str, Any] | None = None) -> Any:
    base = required_env("BIGCHANGE_BASE_URL").rstrip("/")
    query = {"action": action}
    if params:
        query.update({k: str(v) for k, v in params.items()})
    url = f"{base}?{urllib.parse.urlencode(query)}"
    basic = base64.b64encode(
        f"{required_env('BIGCHANGE_USERNAME')}:{required_env('BIGCHANGE_PASSWORD')}".encode()
    ).decode()
    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Basic {basic}")
    req.add_header("key", required_env("BIGCHANGE_API_KEY"))
    req.add_header("Accept", "application/json")
    with urllib.request.urlopen(req, timeout=180) as resp:
        payload = json.loads(resp.read().decode("utf-8-sig"))
    if str(payload.get("Code")) not in {"0"}:
        raise RuntimeError(f"{action} {payload.get('Code')} {str(payload.get('Result'))[:200]}")
    return payload.get("Result")


def doc_date(doc: dict[str, Any]) -> dt.date | None:
    text = str(doc.get("DocumentDate") or "")[:10]
    try:
        return dt.datetime.strptime(text, "%Y-%m-%d").date()
    except ValueError:
        return None


def cancelled(doc: dict[str, Any]) -> bool:
    for key in ("CancellationDate", "DeletionDate", "RejectionDate"):
        val = doc.get(key)
        if val not in (None, "", "0001-01-01 00:00:00"):
            return True
    return False


def line_amount(line: dict[str, Any], order_type: str) -> D:
    qty = as_dec(line.get("LineQuantity")) or D("1")
    unit = as_dec(line.get("UnitPrice"))
    cost = as_dec(line.get("CostPrice"))
    amount = cost if order_type == "PurchaseOrder" and cost != 0 else unit
    return amount * qty


def doc_amount(doc: dict[str, Any]) -> D:
    order_type = str(doc.get("OrderType") or "")
    return sum((line_amount(ln, order_type) for ln in (doc.get("lines") or [])), ZERO)


def job_id(doc: dict[str, Any]) -> int | None:
    raw = str(doc.get("JobId") or "").strip()
    return int(raw) if raw.isdigit() else None


def margin_of(sale: D, profit: D) -> D | None:
    if sale == 0:
        return None
    return (profit / sale * D("100")).quantize(D("0.1"), rounding=decimal.ROUND_HALF_UP)


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


def fetch_jobs(token: str, created_from: dt.date, created_to: dt.date) -> list[dict[str, Any]]:
    jobs: list[dict[str, Any]] = []
    page = 1
    start = f"{created_from.isoformat()}T00:00:00Z"
    end = f"{created_to.isoformat()}T23:59:59Z"
    while True:
        body = rest_get(
            token,
            f"/v1/jobs?createdAtFrom={start}&createdAtTo={end}&pageNumber={page}&pageSize=1000",
        )
        items = body.get("items") or []
        jobs.extend(items)
        if len(items) < 1000:
            return jobs
        page += 1
        if page > 40:
            return jobs


def fetch_group_refs(token: str, group_ids: list[int]) -> dict[int, dict[str, Any]]:
    out: dict[int, dict[str, Any]] = {}
    ids = sorted(set(group_ids))
    for i in range(0, len(ids), 50):
        chunk = ids[i : i + 50]
        q = "&".join(f"id={x}" for x in chunk)
        body = rest_get(token, f"/v1/jobGroups?{q}&pageNumber=1&pageSize=50")
        for item in body.get("items") or []:
            out[int(item["id"])] = item
    return out


def parse_iso_datetime(value: Any) -> dt.datetime | None:
    if not value:
        return None
    text = str(value).strip().replace("Z", "+00:00")
    try:
        parsed = dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def job_raised_sort_key(job: dict[str, Any]) -> tuple[dt.datetime, int]:
    """Earliest raised job first. BigChange job ids increase as jobs are created."""
    job_id_n = int(job.get("id") or 0)
    parsed = parse_iso_datetime(job.get("createdAt"))
    if parsed is None:
        parsed = dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(microseconds=max(job_id_n, 0))
    return (parsed, job_id_n)


def first_raised_job(members: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not members:
        return None
    return min(members, key=job_raised_sort_key)


def group_owner_category_id(members: list[dict[str, Any]]) -> int | None:
    """The first job raised on a group owns every later job on that group."""
    first = first_raised_job(members)
    if not first:
        return None
    cid = first.get("categoryId")
    return int(cid) if cid not in (None, "") else None


def _category_label(row: dict[str, Any]) -> str:
    for key in ("name", "label", "JobCategoryName", "CategoryName", "Name"):
        val = row.get(key)
        if val not in (None, ""):
            return str(val).strip()
    return ""


def _category_numeric_id(row: dict[str, Any]) -> int | None:
    for key in ("id", "Id", "jobCategoryId", "JobCategoryId", "CategoryId"):
        val = row.get(key)
        if val not in (None, ""):
            return int(val)
    return None


def _rows_from_legacy_categories(result: Any) -> list[dict[str, Any]]:
    if isinstance(result, list):
        return [row for row in result if isinstance(row, dict)]
    if not isinstance(result, dict):
        return []
    for key in ("JobCategoriesList", "Categories", "items", "List"):
        value = result.get(key)
        if isinstance(value, list):
            return [row for row in value if isinstance(row, dict)]
    if _category_numeric_id(result) is not None:
        return [result]
    return []


def lookup_category_id(name: str) -> int:
    """Resolve a staff name to a BigChange job category id. Never guess."""
    target = name.strip().lower()
    if not target:
        raise ConfigError("Staff name is required")
    rows: list[dict[str, Any]] = []
    try:
        body = rest_get(rest_token(), "/v1/jobCategories?pageNumber=1&pageSize=1000")
        if isinstance(body, dict):
            rows = [row for row in (body.get("items") or []) if isinstance(row, dict)]
    except Exception:
        rows = []
    if not rows:
        rows = _rows_from_legacy_categories(legacy("JobCategories"))
    matches: list[int] = []
    for row in rows:
        if _category_label(row).lower() == target:
            cid = _category_numeric_id(row)
            if cid is not None:
                matches.append(cid)
    unique = sorted(set(matches))
    if len(unique) == 1:
        return unique[0]
    if len(unique) > 1:
        raise ConfigError(f"Multiple BigChange job categories named {name!r}: {unique}")
    raise ConfigError(f"No BigChange job category named {name!r}")


def resolve_staff(name: str, *, lookup_fn: Any = None) -> dict[str, Any]:
    """Known category ids first; otherwise look the id up. Do not guess."""
    display = str(name or "").strip()
    if not display:
        raise ConfigError("Staff name is required")
    known = STAFF.get(display.lower())
    if known:
        return dict(known)
    finder = lookup_fn if lookup_fn is not None else lookup_category_id
    return {"name": display, "category_id": int(finder(display))}


def graph_token() -> str:
    tenant = (
        os.environ.get("MS_TENANT_ID")
        or os.environ.get("MICROSOFT_TENANT_ID")
        or os.environ.get("GRAPH_TENANT_ID")
        or os.environ.get("AZURE_TENANT_ID")
    )
    client_id = (
        os.environ.get("MS_CLIENT_ID")
        or os.environ.get("MICROSOFT_CLIENT_ID")
        or os.environ.get("GRAPH_CLIENT_ID")
        or os.environ.get("AZURE_CLIENT_ID")
    )
    client_secret = (
        os.environ.get("MS_CLIENT_SECRET")
        or os.environ.get("MICROSOFT_CLIENT_SECRET")
        or os.environ.get("GRAPH_CLIENT_SECRET")
        or os.environ.get("AZURE_CLIENT_SECRET")
    )
    if not tenant or not client_id or not client_secret:
        raise ConfigError("Missing Microsoft Graph application credentials")
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
        method="POST",
    )
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    with urllib.request.urlopen(req, timeout=60) as resp:
        payload = json.load(resp)
    token = payload.get("access_token")
    if not token:
        raise RuntimeError("Microsoft Graph token response had no access_token")
    return token


def send_graph_mail(
    subject: str,
    html_body: str,
    to_email: str = DEFAULT_MAIL_TO,
    cc_email: str = DEFAULT_MAIL_CC,
) -> None:
    token = graph_token()
    payload = {
        "message": {
            "subject": subject,
            "body": {"contentType": "HTML", "content": html_body},
            "toRecipients": [{"emailAddress": {"address": to_email}}],
            "ccRecipients": [{"emailAddress": {"address": cc_email}}],
        },
        "saveToSentItems": True,
    }
    raw = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"https://graph.microsoft.com/v1.0/users/{urllib.parse.quote(FROM_EMAIL)}/sendMail",
        data=raw,
        method="POST",
    )
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            resp.read()
            print("email", resp.status)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"sendMail {exc.code}: {exc.read().decode()[:800]}") from exc


def month_bounds(year: int, month: int) -> tuple[dt.date, dt.date]:
    last = calendar.monthrange(year, month)[1]
    return dt.date(year, month, 1), dt.date(year, month, last)


def build_staff_rows(
    *,
    jobs: list[dict[str, Any]],
    docs: list[dict[str, Any]],
    group_refs: dict[int, dict[str, Any]],
    category_id: int,
    month_start: dt.date,
    month_end: dt.date,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """One row per completed Group/Job, in the month the last job is invoiced.

    Sale and PO totals are the full group from 1 May 2026, not a single month slice.
    """
    jobs_by_id = {int(j["id"]): j for j in jobs}
    staff_ids = {int(j["id"]) for j in jobs if j.get("categoryId") == category_id}
    by_group: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for j in jobs:
        if j.get("jobGroupId"):
            by_group[int(j["jobGroupId"])].append(j)
    group_owner: dict[int, int | None] = {
        gid: group_owner_category_id(members) for gid, members in by_group.items()
    }

    buckets: dict[str, dict[str, Any]] = {}

    def ensure_bucket(jid: int) -> dict[str, Any]:
        job = jobs_by_id.get(jid) or {}
        gid = int(job["jobGroupId"]) if job.get("jobGroupId") else None
        key = f"g:{gid}" if gid else f"j:{jid}"
        if key not in buckets:
            members = by_group.get(gid, []) if gid else ([job] if job else [])
            buckets[key] = {
                "key": key,
                "gid": gid,
                "jid": None if gid else jid,
                "members": members,
                "sales": [],
                "pos_staff": [],
                "pos_any": [],
                "invoiced_jobs": set(),
            }
        return buckets[key]

    for doc in docs:
        if cancelled(doc):
            continue
        order_type = str(doc.get("OrderType") or "")
        if order_type not in {"Invoice", "CreditNote", "PurchaseOrder"}:
            continue
        jid = job_id(doc)
        if not jid or jid not in jobs_by_id:
            continue
        when = doc_date(doc)
        if not when or when < BEGINNING_OF_TIME:
            continue
        amount = doc_amount(doc)
        job = jobs_by_id[jid]
        gid = int(job["jobGroupId"]) if job.get("jobGroupId") else None
        if gid:
            if group_owner.get(gid) != category_id:
                continue
            ensure_jid = jid if jid in staff_ids else (by_group[gid][0]["id"] if by_group[gid] else jid)
            b = ensure_bucket(int(ensure_jid))
            counts_for_staff = True
        elif jid in staff_ids:
            b = ensure_bucket(jid)
            counts_for_staff = True
        else:
            continue
        if order_type in {"Invoice", "CreditNote"}:
            b["invoiced_jobs"].add(jid)
            if counts_for_staff:
                b["sales"].append((when, amount, order_type))
        elif order_type == "PurchaseOrder":
            b["pos_any"].append((when, amount, jid))
            if counts_for_staff:
                b["pos_staff"].append((when, amount, jid))

    staff_buckets = []
    for b in buckets.values():
        members = b["members"]
        if b["gid"]:
            if group_owner.get(int(b["gid"])) != category_id:
                continue
        else:
            if b["jid"] not in staff_ids:
                continue
        staff_buckets.append(b)

    def label(b: dict[str, Any]) -> str:
        gid = b["gid"]
        if gid and gid in group_refs:
            return group_refs[gid].get("reference") or f"GR/{gid}"
        if b["jid"] and b["jid"] in jobs_by_id:
            return jobs_by_id[b["jid"]].get("reference") or str(b["jid"])
        return b["key"]

    main_rows: list[dict[str, Any]] = []
    anomaly_rows: list[dict[str, Any]] = []

    for b in staff_buckets:
        members = b["members"] or []
        if not group_ready_to_report(members):
            continue

        sales_sorted = sorted(b["sales"], key=lambda x: x[0])
        last_sale = sales_sorted[-1][0] if sales_sorted else None
        if last_sale is None or last_sale < month_start or last_sale > month_end:
            continue

        total_sale = money(sum((amt for _when, amt, _ot in sales_sorted), ZERO))
        total_cost = money(sum((amt for _when, amt, _jid in b["pos_staff"]), ZERO))
        row_date = last_sale

        if is_missing_po_anomaly(total_sale, total_cost):
            anomaly_rows.append(
                {
                    "date": row_date,
                    "reference": label(b),
                    "sale": total_sale,
                    "cost": total_cost,
                    "profit": money(total_sale - total_cost),
                    "margin": margin_of(total_sale, money(total_sale - total_cost)),
                    "reason": "Sale over £250 with no purchase order",
                }
            )
            continue

        if total_sale == 0 and total_cost == 0:
            continue

        profit = money(total_sale - total_cost)
        main_rows.append(
            {
                "key": b["key"],
                "date": row_date,
                "reference": label(b),
                "sale": total_sale,
                "cost": total_cost,
                "profit": profit,
                "margin": margin_of(total_sale, profit),
            }
        )

    main_rows.sort(key=lambda r: (r["date"], r["reference"]))
    anomaly_rows.sort(key=lambda r: (r["date"], r["reference"]))
    return main_rows, anomaly_rows


def day_subtotal(day: dt.date, jobs: list[dict[str, Any]]) -> dict[str, Any]:
    """Date subtotal: sum stored job figures. Do not rerun the commission engine."""
    sale = money(sum((r["sale"] for r in jobs), ZERO))
    cost = money(sum((r["cost"] for r in jobs), ZERO))
    profit = money(sum((r["profit"] for r in jobs), ZERO))
    return {
        "kind": "day_total",
        "date": day,
        "reference": f"{day.strftime('%d/%m/%Y')} total",
        "sale": sale,
        "cost": cost,
        "profit": profit,
        "margin": None,
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


def daily_totals(job_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Day-by-day view: sums of that day's jobs, including summed commission."""
    by_day: dict[dt.date, list[dict[str, Any]]] = defaultdict(list)
    for row in job_rows:
        by_day[row["date"]].append(row)
    out: list[dict[str, Any]] = []
    running_profit = ZERO
    running_commission = ZERO
    for day in sorted(by_day):
        jobs = by_day[day]
        sale = money(sum((r["sale"] for r in jobs), ZERO))
        cost = money(sum((r["cost"] for r in jobs), ZERO))
        profit = money(sale - cost)
        commission = sum_job_commissions(jobs)
        running_profit += profit
        running_commission += commission
        out.append(
            {
                "date": day,
                "sale": sale,
                "cost": cost,
                "profit": profit,
                "margin": margin_of(sale, profit),
                "commission": commission,
                "running_profit": money(running_profit),
                "running_commission": money(running_commission),
            }
        )
    return out


def _td_money(value: D, extra: str = "") -> str:
    style = f"text-align:right;white-space:nowrap;{extra}"
    return f"<td style='{style}'>{gbp(value)}</td>"


QUIET = "color:#4a5560;font-size:10px;font-weight:400;"
RUN_EDGE = "border-left:2px solid #c5d0dc;padding-left:10px;"


def _th_run(label: str, extra: str = "") -> str:
    return (
        f"<th style='font-size:10px;font-weight:500;color:#dce3eb;{extra}'>"
        f"{label}</th>"
    )


def render_job_rows_html(job_rows: list[dict[str, Any]]) -> str:
    html_rows = []
    for row in iter_display_rows(job_rows):
        if row["kind"] == "day_total":
            html_rows.append(
                "<tr style='background:#f4f6f8;'>"
                f"<td colspan='2' style='color:#555;font-size:11px;'>{html.escape(row['reference'])}</td>"
                + _td_money(row["sale"])
                + _td_money(row["cost"])
                + _td_money(row["profit"])
                + "<td></td>"
                + _td_money(row["commission"], commission_style(row["commission"]))
                + _td_money(row["running_profit"], f"{QUIET}{RUN_EDGE}")
                + _td_money(row["running_commission"], QUIET)
                + "</tr>"
            )
            continue
        ms = "n/a" if row["margin"] is None else f"{row['margin']}%"
        html_rows.append(
            "<tr>"
            f"<td style='white-space:nowrap;'>{row['date'].strftime('%d/%m/%Y')}</td>"
            f"<td style='white-space:nowrap;'>{html.escape(str(row['reference']))}</td>"
            + _td_money(row["sale"])
            + _td_money(row["cost"])
            + _td_money(row["profit"])
            + f"<td style='text-align:right;white-space:nowrap;{margin_style(row['margin'])}'>{ms}</td>"
            + _td_money(row["commission"], commission_style(row["commission"]))
            + _td_money(row["running_profit"], f"{QUIET}{RUN_EDGE}")
            + _td_money(row["running_commission"], QUIET)
            + "</tr>"
        )
    return "".join(html_rows)


def render_daily_html(days: list[dict[str, Any]]) -> str:
    parts = []
    for row in days:
        ms = "n/a" if row["margin"] is None else f"{row['margin']}%"
        parts.append(
            "<tr>"
            f"<td style='white-space:nowrap'>{row['date'].strftime('%d/%m/%Y')}</td>"
            + _td_money(row["sale"])
            + _td_money(row["cost"])
            + _td_money(row["profit"])
            + f"<td style='text-align:right;white-space:nowrap;{margin_style(row['margin'])}'>{ms}</td>"
            + _td_money(row["commission"], commission_style(row["commission"]))
            + _td_money(row["running_profit"])
            + _td_money(row["running_commission"], commission_style(row["running_commission"]))
            + "</tr>"
        )
    return "".join(parts)


def _score_row(label: str, value: str, extra_value: str = "", top: bool = False) -> str:
    pad = "12px" if top else "7px"
    return (
        "<tr>"
        f"<td style='padding:{pad} 16px 7px 0;font-size:14px;color:#333;'>{html.escape(label)}</td>"
        f"<td align='right' width='160' style='padding:{pad} 0 7px 0;white-space:nowrap;"
        f"font-weight:700;font-size:14px;text-align:right;{extra_value}'>{value}</td>"
        "</tr>"
    )


def render_qualification_html(q) -> str:
    if q.qualified:
        status_bg = "#d4edda"
        status_fg = "#155724"
    else:
        status_bg = "#fff3cd"
        status_fg = "#856404"
    current_margin = "n/a" if q.overall_margin is None else f"{margin_of(q.total_revenue, q.total_profit)}%"
    if q.qualified:
        extra = (
            f"<p style='font-size:14px;font-weight:700;color:#155724;margin:12px 0 0;'>"
            f"{html.escape(q.earned_message)}</p>"
        )
    else:
        extra = ""
    min_margin_display = f"{q.min_margin.quantize(D('0.1'))}%"
    return f"""
    <div style="margin:0 0 20px;padding:16px;border:1px solid #c5d0dc;border-radius:8px;background:#f7fafc;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        {_score_row("Total revenue", gbp(q.total_revenue))}
        {_score_row("Total profit", gbp(q.total_profit))}
        {_score_row("Overall margin", current_margin)}
        {_score_row("Commission", gbp(q.running_commission), commission_style(q.running_commission))}
        {_score_row("Minimum profit required", gbp(q.min_profit), top=True)}
        {_score_row("Current profit", gbp(q.total_profit))}
        {_score_row("Remaining", gbp(q.profit_remaining))}
        {_score_row("Minimum margin required", min_margin_display)}
        {_score_row("Current margin", current_margin)}
      </table>
      <p style="margin:14px 0 0;padding:10px 12px;background:{status_bg};color:{status_fg};font-weight:700;font-size:15px;display:inline-block;">
        STATUS: {html.escape(q.status)}
      </p>
      {extra}
    </div>
    """


def build_html(
    *,
    staff_name: str,
    month_label: str,
    job_rows: list[dict[str, Any]],
    anomaly_rows: list[dict[str, Any]],
) -> str:
    total_sale = money(sum((r["sale"] for r in job_rows), ZERO))
    total_cost = money(sum((r["cost"] for r in job_rows), ZERO))
    total_profit = money(total_sale - total_cost)
    total_margin = margin_of(total_sale, total_profit)
    total_commission = sum_job_commissions(job_rows)
    qualification = qualify_month(total_sale, total_profit, total_commission)
    job_body = render_job_rows_html(job_rows)
    table_wrap = "overflow-x:auto;-webkit-overflow-scrolling:touch;width:100%;"
    table_css = "border-collapse:collapse;font-size:11px;border-color:#ccc;width:100%;min-width:760px;"
    head = "background:#1f3a5f;color:#fff;"
    anomaly_section = ""
    if anomaly_rows:
        anomaly_body = ""
        for r in anomaly_rows:
            ms = "n/a" if r["margin"] is None else f"{r['margin']}%"
            anomaly_body += (
                "<tr>"
                f"<td style='white-space:nowrap;'>{r['date'].strftime('%d/%m/%Y')}</td>"
                f"<td style='white-space:nowrap;'>{html.escape(str(r['reference']))}</td>"
                f"{_td_money(r['sale'])}{_td_money(r['cost'])}{_td_money(r['profit'])}"
                f"<td style='text-align:right;{margin_style(r['margin'])}'>{ms}</td>"
                f"<td>{html.escape(r['reason'])}</td>"
                "</tr>"
            )
        anomaly_section = f"""
      <h2 style="color:#721c24;font-size:16px;margin-top:28px;">Anomalies</h2>
      <div style="{table_wrap}">
      <table cellpadding="6" cellspacing="0" border="1" style="{table_css}">
        <thead>
          <tr style="background:#721c24;color:#fff;">
            <th>Date</th><th>Group / job</th>
            <th>Invoiced</th><th>Purchase orders</th><th>Profit</th><th>Margin</th><th>Why</th>
          </tr>
        </thead>
        <tbody>{anomaly_body}</tbody>
      </table>
      </div>
        """

    tile_lab = "padding:8px 8px 4px 8px;color:#fff;font-size:11px;line-height:1.2;"
    tile_val = "padding:0 8px 10px 8px;color:#fff;font-size:16px;font-weight:700;white-space:nowrap;"
    return f"""
    <div style="font-family:Arial,Helvetica,sans-serif;color:#222;max-width:1100px;">
      <h1 style="color:#1f3a5f;margin-bottom:12px;">{html.escape(staff_name)} — {html.escape(month_label)} commission report</h1>

      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">
        <tr>
          <td width="20%" style="background:#1f3a5f;{tile_lab}">Overall profit</td>
          <td width="20%" style="background:#2e5a8f;{tile_lab}">Invoiced</td>
          <td width="20%" style="background:#3d6fa3;{tile_lab}">Purchase orders</td>
          <td width="20%" style="background:#4a82b8;{tile_lab}">Margin</td>
          <td width="20%" style="background:#1b7a4a;{tile_lab}">Commission</td>
        </tr>
        <tr>
          <td width="20%" style="background:#1f3a5f;{tile_val}">{gbp(total_profit)}</td>
          <td width="20%" style="background:#2e5a8f;{tile_val}">{gbp(total_sale)}</td>
          <td width="20%" style="background:#3d6fa3;{tile_val}">{gbp(total_cost)}</td>
          <td width="20%" style="background:#4a82b8;{tile_val}">{'n/a' if total_margin is None else f'{total_margin}%'}</td>
          <td width="20%" style="background:#1b7a4a;{tile_val}">{gbp(total_commission)}</td>
        </tr>
      </table>

      {render_qualification_html(qualification)}

      <div style="{table_wrap}">
      <table cellpadding="6" cellspacing="0" border="1" style="{table_css}">
        <thead>
          <tr style="{head}">
            <th>Date</th>
            <th>Group / job</th>
            <th>Invoiced</th><th>Purchase orders</th>
            <th>Profit</th><th>Margin</th><th>Commission</th>
            {_th_run("Run profit", RUN_EDGE + "border-left-color:#fff;")}
            {_th_run("Run comm.")}
          </tr>
        </thead>
        <tbody>
          {job_body}
          <tr style="{head}font-weight:700;">
            <td colspan="2">Total — {len(job_rows)} groups/jobs</td>
            {_td_money(total_sale)}{_td_money(total_cost)}{_td_money(total_profit)}
            <td style="text-align:right">{'n/a' if total_margin is None else f'{total_margin}%'}</td>
            {_td_money(total_commission, commission_style(total_commission))}
            {_td_money(total_profit, f"{QUIET}{RUN_EDGE}border-left-color:#fff;")}
            {_td_money(total_commission, QUIET)}
          </tr>
        </tbody>
      </table>
      </div>
      {anomaly_section}
    </div>
    """


def load_report_data(
    category_id: int,
    month_start: dt.date,
    month_end: dt.date,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    token = rest_token()
    created_from = BEGINNING_OF_TIME
    created_to = max(month_end, dt.datetime.now(LONDON).date())
    jobs = fetch_jobs(token, created_from, created_to)
    docs = legacy(
        "InvoicesWithItemsByPeriod",
        {"Start": created_from.isoformat(), "End": created_to.isoformat()},
    )["InvoicesList"]
    jobs_by_id = {int(j["id"]): j for j in jobs}
    by_group: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for j in jobs:
        if j.get("jobGroupId"):
            by_group[int(j["jobGroupId"])].append(j)
    group_ids: list[int] = []
    for j in jobs:
        if j.get("categoryId") == category_id and j.get("jobGroupId"):
            group_ids.append(int(j["jobGroupId"]))
    for doc in docs:
        jid = job_id(doc)
        if not jid or jid not in jobs_by_id:
            continue
        job = jobs_by_id[jid]
        if job.get("jobGroupId"):
            gid = int(job["jobGroupId"])
            members = by_group.get(gid, [])
            if any(m.get("categoryId") == category_id for m in members):
                group_ids.append(gid)
    group_refs = fetch_group_refs(token, group_ids)
    return build_staff_rows(
        jobs=jobs,
        docs=docs,
        group_refs=group_refs,
        category_id=category_id,
        month_start=month_start,
        month_end=month_end,
    )


def current_report_month(today: dt.date | None = None) -> tuple[int, int]:
    """Current Europe/London calendar month only."""
    when = today if today is not None else dt.datetime.now(LONDON).date()
    return when.year, when.month


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    year, month = current_report_month()
    parser = argparse.ArgumentParser(description="Staff commission report")
    parser.add_argument("--staff", default=STAFF_NAME)
    parser.add_argument("--year", type=int, default=year)
    parser.add_argument("--month", type=int, default=month)
    parser.add_argument("--send", action="store_true", help="Email the report")
    parser.add_argument("--to", default=os.environ.get("STAFF_PROFIT_MAIL_TO", DEFAULT_MAIL_TO))
    parser.add_argument("--cc", default=os.environ.get("STAFF_PROFIT_MAIL_CC", DEFAULT_MAIL_CC))
    parser.add_argument("--out", default="")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    staff = resolve_staff(args.staff)
    month_start, month_end = month_bounds(args.year, args.month)
    month_label = month_start.strftime("%B %Y")
    main_rows, anomaly_rows = load_report_data(staff["category_id"], month_start, month_end)
    job_rows = attach_job_commissions(main_rows)
    html_body = build_html(
        staff_name=staff["name"],
        month_label=month_label,
        job_rows=job_rows,
        anomaly_rows=anomaly_rows,
    )
    total_sale = money(sum((r["sale"] for r in job_rows), ZERO))
    total_profit = money(sum((r["profit"] for r in job_rows), ZERO))
    total_commission = sum_job_commissions(job_rows)
    q = qualify_month(total_sale, total_profit, total_commission)
    print(
        {
            "staff": staff["name"],
            "month": month_label,
            "rows": len(job_rows),
            "sale": str(total_sale),
            "profit": str(total_profit),
            "commission": str(total_commission),
            "status": q.status,
            "anomalies": len(anomaly_rows),
        }
    )
    out_path = args.out or f"/tmp/{args.staff}_{month_start.strftime('%Y_%m')}_commission.html"
    with open(out_path, "w") as handle:
        handle.write(
            "<!doctype html><html><head><meta charset='utf-8'>"
            f"<meta name='viewport' content='width=device-width, initial-scale=1'>"
            f"<title>{staff['name']} {month_label} commission report</title></head>"
            "<body style='margin:24px;background:#fff;'>" + html_body + "</body></html>"
        )
    print("wrote", out_path)
    if args.send:
        subject = f"{staff['name']} — {month_label} — commission report"
        try:
            send_graph_mail(subject, html_body, args.to, args.cc)
        except Exception:
            time.sleep(2)
            send_graph_mail(subject, html_body, args.to, args.cc)
    return 0


if __name__ == "__main__":
    sys.exit(main())


