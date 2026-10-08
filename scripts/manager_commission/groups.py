"""Attributed, miscellaneous, and excluded job groups.

Mapped account-manager groups come from the company engine. This module only
classifies groups that engine did not already claim, using the same completion,
document, purchase-order, labour, contract, and exclusion helpers.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable
from typing import Any

from .models import GroupFact
from .money import ZERO, margin_percent, money

PoCost = Callable[[list[dict[str, Any]], list[dict[str, Any]], Any], Any]
AnomalyCheck = Callable[[Any, Any, Any], bool]
ContractReason = Callable[[list[dict[str, Any]], list[dict[str, Any]]], str]


class ReconciliationError(RuntimeError):
    pass


def _category_reason(engine: Any, job: dict[str, Any]) -> str:
    name = engine.job_category_name(job)
    upper = name.upper()
    if upper.startswith("OOH"):
        return "Excluded OOH work"
    if "NIRVANA PPM" in upper:
        return "Excluded Nirvana PPM"
    return "Excluded category"


def unclaimed_group_facts(
    *,
    jobs: list[dict[str, Any]],
    docs: list[dict[str, Any]],
    claimed_ids: set[int],
    team_category_ids: set[int],
    month_start: dt.date,
    month_end: dt.date,
    today: dt.date,
    resource_groups: dict[str, str] | None,
    engine: Any,
    labour_module: Any,
    po_cost: PoCost,
    is_anomaly: AnomalyCheck,
    contract_reason: ContractReason | None,
    anomaly_reason: str,
) -> list[GroupFact]:
    """Classify completed in-month groups the staff engines did not already return."""
    jobs_by_id, by_group = engine.index_jobs(jobs)
    docs_by_group = engine.attach_docs_to_groups(docs, jobs_by_id, known_groups=set(by_group))
    labour_by_job = labour_module.compute_job_labour(
        list(jobs_by_id.values()),
        docs_by_group=docs_by_group,
        group_map=resource_groups,
    )
    include_until = engine.inclusion_end(month_end, today)
    facts: list[GroupFact] = []

    for gid, members in by_group.items():
        if int(gid) in claimed_ids:
            continue
        first = engine.first_job(members)
        if first is None:
            continue
        group_docs = docs_by_group.get(gid, [])
        sale_docs = [doc for doc in group_docs if doc.get("kind") in {"invoice", "credit"}]
        if not sale_docs:
            continue
        last_sale = engine.last_invoice_date(group_docs)
        if last_sale is None or last_sale < month_start or last_sale > include_until:
            continue

        reference = engine.job_group_reference(first, gid)
        owner_name = engine.job_category_name(first) or "Unallocated"
        owner_id = engine.job_category_id(first)
        sale = engine.sum_kind(group_docs, {"invoice", "credit"})

        if not engine.group_all_jobs_completed(members):
            facts.append(
                _fact(
                    gid,
                    reference,
                    owner_name,
                    sale,
                    engine.sum_kind(group_docs, {"po"}),
                    ZERO,
                    ZERO,
                    None,
                    "excluded",
                    "Incomplete group",
                    False,
                    last_sale,
                )
            )
            continue

        if engine.is_excluded_pack_category(first):
            facts.append(
                _fact(
                    gid,
                    reference,
                    owner_name,
                    sale,
                    engine.sum_kind(group_docs, {"po"}),
                    ZERO,
                    ZERO,
                    None,
                    "excluded",
                    _category_reason(engine, first),
                    False,
                    last_sale,
                )
            )
            continue

        reason = contract_reason(members, group_docs) if contract_reason else ""
        if reason:
            po = po_cost(group_docs, members, sale)
            labour = _group_labour(engine, labour_by_job, members)
            profit = money(sale - po - labour)
            facts.append(
                _fact(
                    gid,
                    reference,
                    owner_name,
                    sale,
                    po,
                    labour,
                    profit,
                    margin_percent(sale, profit),
                    "excluded",
                    reason,
                    True,
                    last_sale,
                )
            )
            continue

        po = po_cost(group_docs, members, sale)
        labour = _group_labour(engine, labour_by_job, members)
        profit = money(sale - po - labour)
        margin = margin_percent(sale, profit)
        if is_anomaly(sale, po, labour):
            facts.append(
                _fact(
                    gid,
                    reference,
                    owner_name,
                    sale,
                    po,
                    labour,
                    profit,
                    margin,
                    "anomaly",
                    anomaly_reason,
                    True,
                    last_sale,
                )
            )
            continue
        if sale == 0 and po == 0:
            continue
        if owner_id in team_category_ids:
            raise ReconciliationError(
                f"Job group {reference} ({gid}) belongs to a mapped account manager "
                "but is missing from that person's commission engine output"
            )
        facts.append(
            _fact(
                gid,
                reference,
                owner_name or "Unallocated",
                sale,
                po,
                labour,
                profit,
                margin,
                "miscellaneous",
                "",
                True,
                last_sale,
            )
        )
    return facts


def _group_labour(engine: Any, labour_by_job: dict[Any, Any], members: list[dict[str, Any]]) -> Any:
    return money(sum((labour_by_job.get(engine.job_id_of(member), ZERO) for member in members), ZERO))


def _fact(
    gid: int,
    reference: str,
    owner_name: str,
    sale: Any,
    po: Any,
    labour: Any,
    profit: Any,
    margin: Any,
    bucket: str,
    reason: str,
    reliable: bool,
    on_date: dt.date | None,
) -> GroupFact:
    return GroupFact(
        gid=int(gid),
        reference=reference,
        owner_name=owner_name or "Unallocated",
        sale=money(sale),
        po=money(po),
        labour=money(labour),
        profit=money(profit),
        margin=margin,
        bucket=bucket,
        reason=reason,
        reliable_profit=reliable,
        on_date=on_date,
    )
