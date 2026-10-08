"""Manager bonus from staff-engine results. Staff commission is not recalculated."""

from __future__ import annotations

import datetime as dt

from .config import ManagerTarget, long_date, month_label, period_id
from .models import (
    AttentionItem,
    CompanySnapshot,
    ManagerReport,
    NegativeJob,
    Reconciliation,
    StaffLine,
    StaffResult,
)
from .money import ZERO, gbp, gbp_whole, margin_percent, money

D = __import__("decimal").Decimal


def qualification_status(qualified: bool) -> str:
    return "Qualified" if qualified else "Not qualified"


def staff_negative_commission(staff: StaffResult) -> D:
    return money(sum((money(row.get("commission")) for row in staff.job_rows if money(row.get("commission")) < 0), ZERO))


def manager_contribution(staff: StaffResult, rate: D) -> D:
    """25% of qualified net commission, or 25% of unqualified negative adjustments.

    Qualified net commission already includes that person's job penalties.
    Those penalties are not applied again. Unqualified positive commission is ignored.
    """
    if staff.qualified:
        return money(staff.net_running_commission * rate)
    return money(staff_negative_commission(staff) * rate)


def payable_bonus(running: D, company_profit: D, gate: D) -> D:
    """Positive bonus only after the company profit gate. Never a salary deduction."""
    if money(company_profit) < money(gate):
        return ZERO
    running = money(running)
    if running <= 0:
        return ZERO
    return running


def _claimed_ids(staff: list[StaffResult]) -> set[int]:
    claimed: set[int] = set()
    owners: dict[int, str] = {}
    for person in staff:
        for gid in person.group_ids:
            if gid in owners:
                raise ValueError(
                    f"Job group {gid} is in both {owners[gid]} and {person.name} commission results"
                )
            owners[gid] = person.name
            claimed.add(gid)
        for row in person.anomaly_rows + person.contract_rows:
            claimed.add(int(row["gid"]))
    return claimed


def _attention_from_staff(staff: list[StaffResult]) -> list[AttentionItem]:
    items: list[AttentionItem] = []
    seen: set[int] = set()
    for person in staff:
        for row in person.anomaly_rows:
            gid = int(row["gid"])
            if gid in seen:
                continue
            seen.add(gid)
            items.append(
                AttentionItem(
                    owner=person.name,
                    reference=str(row.get("reference") or gid),
                    gid=gid,
                    sale=money(row.get("sale")),
                    profit=money(row.get("profit")),
                    reason=str(row.get("reason") or "Excluded from commission"),
                )
            )
        for row in person.contract_rows:
            gid = int(row["gid"])
            if gid in seen:
                continue
            seen.add(gid)
            items.append(
                AttentionItem(
                    owner=person.name,
                    reference=str(row.get("reference") or gid),
                    gid=gid,
                    sale=money(row.get("sale")),
                    profit=money(row.get("profit")),
                    reason=str(row.get("reason") or "Excluded contract"),
                )
            )
    return items


def _negative_jobs(staff: list[StaffResult], rate: D, excluded_ids: set[int]) -> list[NegativeJob]:
    rows: list[NegativeJob] = []
    for person in staff:
        for row in person.job_rows:
            commission = money(row.get("commission"))
            if commission >= 0:
                continue
            gid = int(row["gid"])
            treatment = ""
            if gid in excluded_ids:
                treatment = "Also listed as excluded. Counted once, in the exclusion section."
            impact = money(commission * rate)
            rows.append(
                NegativeJob(
                    owner=person.name,
                    reference=str(row.get("reference") or gid),
                    gid=gid,
                    sale=money(row.get("sale")),
                    po=money(row.get("cost")),
                    labour=money(row.get("labour")),
                    profit=money(row.get("profit")),
                    margin=row.get("margin"),
                    staff_commission=commission,
                    manager_impact=impact,
                    qualified_owner=person.qualified,
                    treatment=treatment,
                )
            )
    rows.sort(key=lambda row: (row.manager_impact, row.owner, row.reference))
    return rows


def _priorities(report_staff: list[StaffLine], negative_jobs: list[NegativeJob], attention: list[AttentionItem]) -> list[str]:
    priorities: list[str] = []
    counted = [row for row in negative_jobs if not row.treatment]
    if counted:
        worst_impact = counted[0].manager_impact
        tied = [row for row in counted if row.manager_impact == worst_impact]
        if len(tied) > 1:
            shown = tied[:3]
            names = ", ".join(f"{row.reference} ({row.owner})" for row in shown)
            extra = len(tied) - len(shown)
            suffix = f", and {extra} more" if extra else ""
            priorities.append(
                f"{names}{suffix} share the largest manager impact of {gbp(worst_impact)}."
            )
        else:
            worst = tied[0]
            same_owner = [row for row in counted if row.owner == worst.owner]
            if len(same_owner) > 1:
                priorities.append(
                    f"{worst.owner} has {len(same_owner)} jobs with negative commission. "
                    f"The largest is {worst.reference}: staff commission {gbp(worst.staff_commission)}, "
                    f"manager impact {gbp(worst.manager_impact)}."
                )
            else:
                priorities.append(
                    f"{worst.reference}, owned by {worst.owner}, has staff commission "
                    f"{gbp(worst.staff_commission)} and a manager impact of {gbp(worst.manager_impact)}."
                )
    unqualified = [person for person in report_staff if not person.qualified]
    if unqualified:
        def remaining(person: StaffLine) -> D:
            return money(max(ZERO, person.profit_gate - person.profit))

        closest = min(unqualified, key=lambda person: (remaining(person), person.name))
        gap = remaining(closest)
        priorities.append(
            f"{closest.name} is the closest to qualifying, with {gbp(gap)} profit still needed "
            f"to reach {gbp_whole(closest.profit_gate)}."
        )
    elif report_staff:
        priorities.append(
            f"All {len(report_staff)} account managers have qualified. No individual threshold is outstanding."
        )
    if attention:
        largest = max(attention, key=lambda item: (abs(item.sale), item.reference))
        owner = f" ({largest.owner})" if largest.owner else ""
        priorities.append(
            f"{largest.reference}{owner} needs a look: {largest.reason}. Invoiced {gbp(largest.sale)}."
        )
    return priorities[:3]


def assemble_report(
    target: ManagerTarget,
    snapshot: CompanySnapshot,
    *,
    month_start: dt.date,
    as_of: dt.date,
) -> ManagerReport:
    if snapshot.company_key != target.company_key:
        raise ValueError("Refusing to mix a manager target with another company's results")
    _claimed_ids(snapshot.staff)
    staff_ids = {gid for person in snapshot.staff for gid in person.group_ids}
    misc_ids = [fact.gid for fact in snapshot.miscellaneous]
    if staff_ids & set(misc_ids):
        raise ValueError("A job group is in both staff commission and miscellaneous totals")
    attention_ids = {fact.gid for fact in snapshot.attention}
    if staff_ids & attention_ids or set(misc_ids) & attention_ids:
        raise ValueError("An excluded group is also in staff or miscellaneous totals")

    lines: list[StaffLine] = []
    for person in snapshot.staff:
        lines.append(
            StaffLine(
                name=person.name,
                sales=money(person.sales),
                profit=money(person.profit),
                margin=person.margin,
                net_running_commission=money(person.net_running_commission),
                qualified=person.qualified,
                status=qualification_status(person.qualified),
                profit_gate=money(person.profit_gate),
                contribution=manager_contribution(person, target.rate),
                negative_commission=staff_negative_commission(person),
            )
        )

    staff_sales = money(sum((line.sales for line in lines), ZERO))
    staff_profit = money(sum((line.profit for line in lines), ZERO))
    staff_commission = money(sum((line.net_running_commission for line in lines), ZERO))
    staff_contribution = money(sum((line.contribution for line in lines), ZERO))
    misc_sales = money(sum((fact.sale for fact in snapshot.miscellaneous), ZERO))
    misc_profit = money(sum((fact.profit for fact in snapshot.miscellaneous), ZERO))
    company_sales = money(staff_sales + misc_sales)
    company_profit = money(staff_profit + misc_profit)
    running = staff_contribution
    payable = payable_bonus(running, company_profit, target.profit_gate)
    qualified_count = sum(1 for line in lines if line.qualified)
    manager_qualified = company_profit >= money(target.profit_gate)
    status = qualification_status(manager_qualified)
    remaining = money(max(ZERO, money(target.profit_gate) - company_profit))

    qualified_net = money(
        sum((line.net_running_commission for line in lines if line.qualified), ZERO)
    )
    unqualified_negative = money(
        sum((line.negative_commission for line in lines if not line.qualified), ZERO)
    )

    excluded_ids = {int(row["gid"]) for person in snapshot.staff for row in person.anomaly_rows + person.contract_rows}
    excluded_ids.update(fact.gid for fact in snapshot.attention)
    negative = _negative_jobs(snapshot.staff, target.rate, excluded_ids)
    negative_in_total = [row for row in negative if not row.treatment]
    attention = _attention_from_staff(snapshot.staff)
    seen = {item.gid for item in attention}
    for fact in snapshot.attention:
        if fact.gid in seen or fact.bucket not in {"anomaly", "excluded"}:
            continue
        seen.add(fact.gid)
        attention.append(
            AttentionItem(
                owner=fact.owner_name,
                reference=fact.reference,
                gid=fact.gid,
                sale=fact.sale,
                profit=fact.profit if fact.reliable_profit else None,
                reason=fact.reason,
            )
        )
    attention.sort(key=lambda item: (-abs(item.sale), item.reference))
    priorities = _priorities(lines, negative, attention)
    reconciliation = Reconciliation(
        qualified_staff_net=qualified_net,
        unqualified_negative=unqualified_negative,
        manager_share=running,
        company_profit=company_profit,
        required_profit=money(target.profit_gate),
        remaining_profit=remaining,
        status=status,
        running_bonus=running,
        payable_bonus=payable,
    )
    return ManagerReport(
        company_name=target.company_name,
        company_key=target.company_key,
        manager_name=target.manager_name,
        manager_email=target.manager_email,
        cc_email=target.cc_email,
        rate=target.rate,
        month_label=month_label(month_start),
        period_label=f"{long_date(month_start)} – {long_date(as_of)}",
        period_id=period_id(target.company_key, target.manager_name, month_start),
        timezone=target.timezone,
        staff_lines=lines,
        staff_sales=staff_sales,
        staff_profit=staff_profit,
        staff_commission=staff_commission,
        staff_contribution=staff_contribution,
        miscellaneous_sales=misc_sales,
        miscellaneous_profit=misc_profit,
        miscellaneous_margin=margin_percent(misc_sales, misc_profit),
        miscellaneous_group_ids=list(misc_ids),
        company_sales=company_sales,
        company_profit=company_profit,
        company_margin=margin_percent(company_sales, company_profit),
        qualified_count=qualified_count,
        team_size=len(lines),
        running_bonus=running,
        payable_bonus=payable,
        manager_qualified=manager_qualified,
        manager_status=status,
        remaining_profit=remaining,
        profit_gate=money(target.profit_gate),
        negative_jobs=negative,
        negative_staff_total=money(sum((row.staff_commission for row in negative_in_total), ZERO)),
        negative_manager_total=money(sum((row.manager_impact for row in negative_in_total), ZERO)),
        attention=attention,
        attention_value=money(sum((item.sale for item in attention), ZERO)),
        reconciliation=reconciliation,
        priorities=priorities,
        notes=list(snapshot.notes),
        delivery_mode=target.delivery_mode,
    )
