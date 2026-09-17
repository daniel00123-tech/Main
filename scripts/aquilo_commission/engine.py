"""Ownership, hold gates, sale / PO / labour / profit for Aquilo groups."""

from __future__ import annotations

import datetime as dt
from collections import defaultdict
from typing import Any

from .labour import compute_job_labour, is_cancelled_job
from .settings import (
    ANOMALY_SALE,
    CANCELLED_STATUSES,
    COMPLETED_STATUSES,
    MIN_PO_AMOUNT,
    STAFF_BY_CATEGORY,
    inclusion_end,
)
from .util import as_int, clean_name, first_present, money, parse_datetime
from .jobwatch import normalize_document

D = __import__("decimal").Decimal
ZERO = D("0")


def job_id_of(job: dict[str, Any]) -> int | None:
    return as_int(first_present(job, ("JobId", "Id", "JobID")))


def job_group_id(job: dict[str, Any]) -> int | None:
    group = job.get("JobGroup")
    if isinstance(group, dict):
        gid = as_int(first_present(group, ("JobGroupId", "Id", "ID")))
        if gid:
            return gid
    return as_int(first_present(job, ("JobGroupId", "GroupId")))


def job_group_reference(job: dict[str, Any], gid: int | None) -> str:
    group = job.get("JobGroup")
    if isinstance(group, str) and group.strip():
        return clean_name(group)
    if isinstance(group, dict):
        ref = first_present(group, ("JobGroupReference", "Reference", "Ref", "GroupReference"))
        if ref:
            return clean_name(ref)
    ref = first_present(job, ("JobGroupReference", "GroupReference", "GroupRef"))
    if ref:
        return clean_name(ref)
    if gid:
        return f"GR/{gid}"
    jid = job_id_of(job)
    return f"JOB/{jid}" if jid else "UNKNOWN"


def job_category_id(job: dict[str, Any]) -> int | None:
    return as_int(
        first_present(
            job,
            ("JobCategoryId", "CategoryId", "JobCategoryID", "CategoryID"),
        )
    )


def job_category_name(job: dict[str, Any]) -> str:
    return clean_name(
        first_present(
            job,
            ("Category", "CategoryName", "JobCategory", "JobCategoryName", "JobCategoryLabel"),
        )
    )


def is_excluded_pack_category(job: dict[str, Any]) -> bool:
    name = job_category_name(job)
    upper = name.upper()
    if upper.startswith("OOH"):
        return True
    if "NIRVANA PPM" in upper:
        return True
    return False


def job_status(job: dict[str, Any]) -> str:
    return clean_name(first_present(job, ("Status", "JobStatus", "State")))


def job_created(job: dict[str, Any]) -> dt.datetime:
    parsed = parse_datetime(first_present(job, ("Created", "CreatedDate", "DateCreated", "LoggedDate")))
    jid = job_id_of(job) or 0
    if parsed is None:
        return dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(microseconds=max(jid, 0))
    return parsed


def live_jobs(members: list[dict[str, Any]]) -> list[dict[str, Any]]:
    live = []
    for job in members:
        if is_cancelled_job(job):
            continue
        if job_status(job).lower() in CANCELLED_STATUSES:
            continue
        live.append(job)
    return live


def group_all_jobs_completed(members: list[dict[str, Any]]) -> bool:
    live = live_jobs(members)
    if not live:
        return False
    return all(job_status(job).lower() in COMPLETED_STATUSES for job in live)


def first_job(members: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not members:
        return None
    return min(members, key=lambda job: (job_created(job), job_id_of(job) or 0))


def group_owner_category_id(members: list[dict[str, Any]]) -> int | None:
    first = first_job(members)
    if not first:
        return None
    if is_excluded_pack_category(first):
        return None
    return job_category_id(first)


def is_missing_po_anomaly(sale: D, po_cost: D) -> bool:
    return sale > ANOMALY_SALE and abs(po_cost) < MIN_PO_AMOUNT


def index_jobs(raw_jobs: list[dict[str, Any]]) -> tuple[dict[int, dict[str, Any]], dict[int, list[dict[str, Any]]]]:
    by_id: dict[int, dict[str, Any]] = {}
    by_group: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for job in raw_jobs:
        jid = job_id_of(job)
        if jid is None:
            continue
        tagged = dict(job)
        tagged["_job_id"] = jid
        gid = job_group_id(job)
        tagged["_group_id"] = gid
        by_id[jid] = tagged
        if gid:
            by_group[gid].append(tagged)
    return by_id, by_group


def attach_docs_to_groups(
    docs: list[dict[str, Any]],
    jobs_by_id: dict[int, dict[str, Any]],
) -> dict[int, list[dict[str, Any]]]:
    """Prefer JobId. JobGroupId is often blank on POs. Dedupe by documentId."""
    grouped: dict[int, dict[str, dict[str, Any]]] = defaultdict(dict)
    for raw in docs:
        normalised = normalize_document(raw)
        if not normalised:
            continue
        jid = normalised["job_id"]
        if not jid or jid not in jobs_by_id:
            continue
        job = jobs_by_id[jid]
        gid = job.get("_group_id")
        if not gid:
            continue
        key = normalised["document_id"] or f"{normalised['kind']}:{jid}:{normalised['document_date']}:{normalised['net_ex_vat']}"
        grouped[int(gid)][key] = normalised
    return {gid: list(bucket.values()) for gid, bucket in grouped.items()}


def last_invoice_date(docs: list[dict[str, Any]]) -> dt.date | None:
    dates = [d["document_date"] for d in docs if d.get("kind") in {"invoice", "credit"} and d.get("document_date")]
    return max(dates) if dates else None


def sum_kind(docs: list[dict[str, Any]], kinds: set[str]) -> D:
    return money(sum((d.get("net_ex_vat") or ZERO for d in docs if d.get("kind") in kinds), ZERO))


def build_staff_report(
    *,
    jobs: list[dict[str, Any]],
    docs: list[dict[str, Any]],
    category_id: int,
    month_start: dt.date,
    month_end: dt.date,
    today: dt.date,
    resource_groups: dict[str, str] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    """Grouped jobs only. One row per JobGroupId owned by the AM."""
    if category_id not in STAFF_BY_CATEGORY:
        return [], [], []

    jobs_by_id, by_group = index_jobs(jobs)
    docs_by_group = attach_docs_to_groups(docs, jobs_by_id)

    # Labour is computed across all jobs (day engine is per engineer per day),
    # then rolled into the group row.
    all_jobs = list(jobs_by_id.values())
    labour_by_job = compute_job_labour(
        all_jobs,
        docs_by_group=docs_by_group,
        group_map=resource_groups,
    )

    include_until = inclusion_end(month_end, today)
    main_rows: list[dict[str, Any]] = []
    anomaly_rows: list[dict[str, Any]] = []
    review_rows: list[dict[str, Any]] = []

    for gid, members in by_group.items():
        owner = group_owner_category_id(members)
        if owner != category_id:
            continue
        if not group_all_jobs_completed(members):
            continue
        group_docs = docs_by_group.get(gid, [])
        sale_docs = [d for d in group_docs if d.get("kind") in {"invoice", "credit"}]
        if not sale_docs:
            continue
        last_sale = last_invoice_date(group_docs)
        if last_sale is None or last_sale < month_start or last_sale > include_until:
            continue

        sale = sum_kind(group_docs, {"invoice", "credit"})
        po = sum_kind(group_docs, {"po"})
        labour = money(sum((labour_by_job.get(job_id_of(m), ZERO) for m in members), ZERO))
        profit = money(sale - po - labour)
        margin = (profit / sale * D("100")) if sale != 0 else None
        reference = job_group_reference(first_job(members) or members[0], gid)
        row = {
            "key": f"g:{gid}",
            "gid": gid,
            "date": last_sale,
            "reference": reference,
            "sale": sale,
            "cost": po,
            "labour": labour,
            "profit": profit,
            "margin": None if margin is None else margin,
            "members": members,
        }

        if is_missing_po_anomaly(sale, po):
            anomaly_rows.append(
                {
                    **row,
                    "reason": "Sale over £250 with no purchase order (Labour is not a PO)",
                }
            )
            continue

        if sale == 0 and po == 0:
            continue

        main_rows.append(row)
        flags: list[str] = []
        if profit < 0:
            flags.append("Negative profit")
        if margin is not None and sale > 0 and margin < D("10"):
            flags.append("Margin below 10%")
        if flags:
            review_rows.append({**row, "flags": flags})

    main_rows.sort(key=lambda r: (r["date"], r["reference"]))
    anomaly_rows.sort(key=lambda r: (r["date"], r["reference"]))
    review_rows.sort(key=lambda r: (r["date"], r["reference"]))
    return main_rows, anomaly_rows, review_rows
