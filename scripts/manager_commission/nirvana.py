"""Nirvana adapter. Staff rows are the Nirvana commission engine's own output."""

from __future__ import annotations

import datetime as dt
from typing import Any

from scripts.nirvana_commission import commission as nirvana_commission
from scripts.nirvana_commission import engine as nirvana_engine
from scripts.nirvana_commission import labour as nirvana_labour
from scripts.nirvana_commission.contracts import classify_contract_group
from scripts.nirvana_commission.jobwatch import (
    NirvanaJobWatchClient,
    fetch_contract_names,
    fetch_finance_history,
    fetch_jobs_history,
    resource_group_map,
)
from scripts.nirvana_commission.render import qualify_rows
from scripts.nirvana_commission.run import ensure_jobs_for_documents
from scripts.nirvana_commission.settings import HISTORY_ANCHOR, STAFF, NirvanaSettings

from .config import NIRVANA_ACCOUNT_MANAGERS, ConfigError
from .groups import unclaimed_group_facts
from .models import CompanySnapshot, StaffResult

ANOMALY_REASON = "Sale over £250 with no purchase order and no labour"


def _po_cost(group_docs: list[dict[str, Any]], members: list[dict[str, Any]], sale: Any) -> Any:
    del members, sale
    return nirvana_engine.sum_kind(group_docs, {"po"})


def _contract_reason(members: list[dict[str, Any]], group_docs: list[dict[str, Any]]) -> str:
    decision = classify_contract_group(members, group_docs)
    return decision.reason if decision.excluded else ""


def _label_contracts(rows: list[dict[str, Any]], names: dict[int, str]) -> None:
    for row in rows:
        if row.get("reason") != "Explicit BigChange contract":
            continue
        for cid in row.get("contract_ids") or []:
            label = names.get(int(cid))
            if label:
                row["reason"] = f"Explicit BigChange contract — {label}"
                break


def _staff_result(key: str, job_rows: list[dict[str, Any]], anomaly_rows: list[dict[str, Any]], contract_rows: list[dict[str, Any]]) -> StaffResult:
    meta = STAFF[key]
    qualification = qualify_rows(job_rows)
    return StaffResult(
        key=key,
        name=str(meta["name"]),
        category_id=int(meta["category_id"]),
        sales=qualification.total_revenue,
        profit=qualification.total_profit,
        margin=qualification.overall_margin,
        net_running_commission=qualification.running_commission,
        qualified=qualification.qualified,
        profit_gate=qualification.min_profit,
        job_rows=job_rows,
        anomaly_rows=anomaly_rows,
        contract_rows=contract_rows,
    )


def build_snapshot(
    jobs: list[dict[str, Any]],
    docs: list[dict[str, Any]],
    *,
    month_start: dt.date,
    month_end: dt.date,
    today: dt.date,
    resource_groups: dict[str, str] | None = None,
    contract_names: dict[int, str] | None = None,
    staff_keys: tuple[str, ...] | list[str] = NIRVANA_ACCOUNT_MANAGERS,
) -> CompanySnapshot:
    unknown = [key for key in staff_keys if key not in STAFF]
    if unknown:
        raise ConfigError(f"Unknown Nirvana account manager: {', '.join(unknown)}")
    names = contract_names or {}
    staff: list[StaffResult] = []
    for key in staff_keys:
        main_rows, anomaly_rows, _review_rows, contract_rows = nirvana_engine.build_staff_report(
            jobs=jobs,
            docs=docs,
            category_id=int(STAFF[key]["category_id"]),
            month_start=month_start,
            month_end=month_end,
            today=today,
            resource_groups=resource_groups,
        )
        _label_contracts(contract_rows, names)
        job_rows = nirvana_commission.attach_job_commissions(main_rows)
        staff.append(_staff_result(key, job_rows, anomaly_rows, contract_rows))

    claimed: set[int] = set()
    for person in staff:
        claimed.update(person.group_ids)
        claimed.update(int(row["gid"]) for row in person.anomaly_rows)
        claimed.update(int(row["gid"]) for row in person.contract_rows)
    facts = unclaimed_group_facts(
        jobs=jobs,
        docs=docs,
        claimed_ids=claimed,
        team_category_ids={int(STAFF[key]["category_id"]) for key in staff_keys},
        month_start=month_start,
        month_end=month_end,
        today=today,
        resource_groups=resource_groups,
        engine=nirvana_engine,
        labour_module=nirvana_labour,
        po_cost=_po_cost,
        is_anomaly=lambda sale, po, labour: nirvana_engine.is_missing_po_anomaly(sale, po, labour),
        contract_reason=_contract_reason,
        anomaly_reason=ANOMALY_REASON,
    )
    notes = _notes(jobs)
    return CompanySnapshot(
        company_key="nirvana",
        staff=staff,
        miscellaneous=[fact for fact in facts if fact.bucket == "miscellaneous"],
        attention=[fact for fact in facts if fact.bucket in {"anomaly", "excluded"}],
        notes=notes,
    )


def _notes(jobs: list[dict[str, Any]]) -> list[str]:
    ungrouped = 0
    for job in jobs:
        if nirvana_engine.job_id_of(job) and not nirvana_engine.job_group_id(job):
            ungrouped += 1
    if not ungrouped:
        return []
    return [
        f"{ungrouped} jobs are not in a job group, so they are left out of this scorecard in the same way as the account-manager reports."
    ]


def load_live(
    settings: NirvanaSettings,
    *,
    month_start: dt.date,
    month_end: dt.date,
    today: dt.date,
) -> CompanySnapshot:
    client = NirvanaJobWatchClient(settings)
    print("fetching Nirvana jobs from", HISTORY_ANCHOR, "to", today, flush=True)
    jobs = fetch_jobs_history(client, today)
    print("jobs", len(jobs), flush=True)
    if not jobs:
        raise ConfigError("Nirvana JobWatch returned no jobs")
    print("fetching Nirvana finance", flush=True)
    docs = fetch_finance_history(client, today)
    print("documents", len(docs), flush=True)
    if not docs:
        raise ConfigError("Nirvana finance fetch returned no documents")
    jobs = ensure_jobs_for_documents(client, jobs, docs)
    groups = resource_group_map(client)
    names = fetch_contract_names(client)
    return build_snapshot(
        jobs,
        docs,
        month_start=month_start,
        month_end=month_end,
        today=today,
        resource_groups=groups,
        contract_names=names,
    )
