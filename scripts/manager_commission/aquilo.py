"""Aquilo adapter. UK staff use this branch's engine. South Africa is used only when that profile is installed."""

from __future__ import annotations

import datetime as dt
import inspect
from typing import Any

from scripts.aquilo_commission import commission as aquilo_commission
from scripts.aquilo_commission import engine as aquilo_engine
from scripts.aquilo_commission import labour as aquilo_labour
from scripts.aquilo_commission.jobwatch import (
    AquiloJobWatchClient,
    fetch_finance_history,
    fetch_jobs_history,
    job_lines_cost,
    resource_group_map,
)
from scripts.aquilo_commission.render import qualify_rows
from scripts.aquilo_commission.run import ensure_jobs_for_documents
from scripts.aquilo_commission.settings import HISTORY_ANCHOR, STAFF, AquiloSettings

from .config import AQUILO_SA_ACCOUNT_MANAGERS, AQUILO_UK_ACCOUNT_MANAGERS, ConfigError
from .groups import unclaimed_group_facts
from .models import CompanySnapshot, StaffResult

ANOMALY_REASON = "Sale over £250 with no purchase order (Labour is not a PO)"


def south_africa_available() -> bool:
    return all(key in STAFF for key in AQUILO_SA_ACCOUNT_MANAGERS) and "profile" in inspect.signature(
        aquilo_commission.attach_job_commissions
    ).parameters


def team_keys() -> tuple[list[str], list[str]]:
    uk = [key for key in AQUILO_UK_ACCOUNT_MANAGERS if key in STAFF]
    missing_uk = [key for key in AQUILO_UK_ACCOUNT_MANAGERS if key not in STAFF]
    if missing_uk:
        raise ConfigError(f"Aquilo UK account managers missing from the engine: {', '.join(missing_uk)}")
    sa = list(AQUILO_SA_ACCOUNT_MANAGERS) if south_africa_available() else []
    return uk, sa


def _po_cost(
    group_docs: list[dict[str, Any]],
    members: list[dict[str, Any]],
    sale: Any,
    job_cost_loader: Any,
) -> Any:
    po = aquilo_engine.resolve_po_cost(group_docs)
    if job_cost_loader is not None and aquilo_engine.is_missing_po_anomaly(sale, po):
        from .money import ZERO, money

        fallback = money(
            sum(
                (job_cost_loader(jid) for jid in (aquilo_engine.job_id_of(member) for member in members) if jid),
                ZERO,
            )
        )
        po = aquilo_engine.resolve_po_cost(group_docs, fallback_cost=fallback)
    return po


def _attach(rows: list[dict[str, Any]], key: str) -> list[dict[str, Any]]:
    if key in AQUILO_SA_ACCOUNT_MANAGERS:
        if not south_africa_available():
            raise ConfigError(
                "Kayla Du Randt uses the Aquilo South Africa commission profile, "
                "which is not on this branch. Staff commission has not been recalculated here."
            )
        profile = aquilo_commission.PROFILE_SOUTH_AFRICA  # type: ignore[attr-defined]
        return aquilo_commission.attach_job_commissions(rows, profile=profile)
    return aquilo_commission.attach_job_commissions(rows)


def _qualify(rows: list[dict[str, Any]], key: str) -> Any:
    qualify = qualify_rows
    if key in AQUILO_SA_ACCOUNT_MANAGERS and "profile" in inspect.signature(qualify).parameters:
        profile = aquilo_commission.PROFILE_SOUTH_AFRICA  # type: ignore[attr-defined]
        return qualify(rows, profile=profile)
    return qualify(rows)


def build_snapshot(
    jobs: list[dict[str, Any]],
    docs: list[dict[str, Any]],
    *,
    month_start: dt.date,
    month_end: dt.date,
    today: dt.date,
    resource_groups: dict[str, str] | None = None,
    job_cost_loader: Any = None,
    staff_keys: list[str] | None = None,
) -> CompanySnapshot:
    uk, sa = team_keys()
    keys = list(staff_keys) if staff_keys is not None else uk + sa
    unknown = [key for key in keys if key not in STAFF]
    if unknown:
        raise ConfigError(
            "Aquilo staff missing from this branch's commission engine: " + ", ".join(unknown)
        )
    staff: list[StaffResult] = []
    for key in keys:
        main_rows, anomaly_rows, _review = aquilo_engine.build_staff_report(
            jobs=jobs,
            docs=docs,
            category_id=int(STAFF[key]["category_id"]),
            month_start=month_start,
            month_end=month_end,
            today=today,
            resource_groups=resource_groups,
            job_cost_loader=job_cost_loader,
        )
        job_rows = _attach(main_rows, key)
        qualification = _qualify(job_rows, key)
        meta = STAFF[key]
        staff.append(
            StaffResult(
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
                contract_rows=[],
            )
        )
    claimed: set[int] = set()
    for person in staff:
        claimed.update(person.group_ids)
        claimed.update(int(row["gid"]) for row in person.anomaly_rows)
    facts = unclaimed_group_facts(
        jobs=jobs,
        docs=docs,
        claimed_ids=claimed,
        team_category_ids={int(STAFF[key]["category_id"]) for key in keys},
        month_start=month_start,
        month_end=month_end,
        today=today,
        resource_groups=resource_groups,
        engine=aquilo_engine,
        labour_module=aquilo_labour,
        po_cost=lambda docs_for_group, members, sale: _po_cost(docs_for_group, members, sale, job_cost_loader),
        is_anomaly=lambda sale, po, labour: aquilo_engine.is_missing_po_anomaly(sale, po),
        contract_reason=None,
        anomaly_reason=ANOMALY_REASON,
    )
    notes: list[str] = []
    if not sa and staff_keys is None:
        notes.append(
            "Kayla Du Randt is configured for Aquilo South Africa, but that commission profile "
            "is not on this branch. No South Africa figures are included and none were estimated."
        )
    return CompanySnapshot(
        company_key="aquilo",
        staff=staff,
        miscellaneous=[fact for fact in facts if fact.bucket == "miscellaneous"],
        attention=[fact for fact in facts if fact.bucket in {"anomaly", "excluded"}],
        notes=notes,
    )


def load_live(
    settings: AquiloSettings,
    *,
    month_start: dt.date,
    month_end: dt.date,
    today: dt.date,
) -> CompanySnapshot:
    client = AquiloJobWatchClient(settings)
    print("fetching Aquilo jobs from", HISTORY_ANCHOR, "to", today, flush=True)
    jobs = fetch_jobs_history(client, today)
    print("jobs", len(jobs), flush=True)
    docs = fetch_finance_history(client, today)
    print("documents", len(docs), flush=True)
    jobs = ensure_jobs_for_documents(client, jobs, docs)
    groups = resource_group_map(client)
    cache: dict[int, Any] = {}

    def job_cost_loader(job_id: int) -> Any:
        if job_id not in cache:
            cache[job_id] = job_lines_cost(client.job_financial_lines(job_id))
        return cache[job_id]

    return build_snapshot(
        jobs,
        docs,
        month_start=month_start,
        month_end=month_end,
        today=today,
        resource_groups=groups,
        job_cost_loader=job_cost_loader,
    )
