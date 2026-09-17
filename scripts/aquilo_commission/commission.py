"""Aquilo job-level commission: 3/4/5% of profit, progressive −£30 cap.

Never calculate commission on invoice lines or subtotal rows.
"""

from __future__ import annotations

import decimal
from dataclasses import dataclass
from typing import Any

from .util import as_decimal, gbp, money

D = decimal.Decimal
ZERO = D("0")

PENALTY_RATE_PO = D("0.20")
MAX_JOB_PENALTY = D("30")
SMALL_JOB_SALE = D("150")
SMALL_JOB_MAX_PENALTY = D("5")
MONTHLY_MIN_PROFIT = D("11000")
MONTHLY_MIN_MARGIN_MESSAGE = D("40")

COMMISSION_TIERS: list[dict[str, Any]] = [
    {
        "minRevenue": D("0"),
        "maxRevenue": D("1999.99"),
        "penaltyBelowMargin": D("20"),
        "bands": [
            {"minMargin": D("20"), "maxMargin": D("29.99"), "rate": D("0")},
            {"minMargin": D("30"), "maxMargin": D("41.99"), "rate": D("0.03")},
            {"minMargin": D("42"), "maxMargin": D("49.99"), "rate": D("0.04")},
            {"minMargin": D("50"), "maxMargin": None, "rate": D("0.05")},
        ],
    },
    {
        "minRevenue": D("2000"),
        "maxRevenue": D("4999.99"),
        "penaltyBelowMargin": D("12.5"),
        "bands": [
            {"minMargin": D("12.5"), "maxMargin": D("34.99"), "rate": D("0.03")},
            {"minMargin": D("35"), "maxMargin": D("42.49"), "rate": D("0.04")},
            {"minMargin": D("42.5"), "maxMargin": None, "rate": D("0.05")},
        ],
    },
    {
        "minRevenue": D("5000"),
        "maxRevenue": None,
        "penaltyBelowMargin": D("10"),
        "bands": [
            {"minMargin": D("10"), "maxMargin": D("19.99"), "rate": D("0.03")},
            {"minMargin": D("20"), "maxMargin": D("31.99"), "rate": D("0.04")},
            {"minMargin": D("32"), "maxMargin": None, "rate": D("0.05")},
        ],
    },
]


def exact_margin_percent(revenue: D, profit: D) -> D | None:
    if revenue == 0:
        return None
    return profit / revenue * D("100")


def select_tier(revenue: D, tiers: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    scheme = tiers if tiers is not None else COMMISSION_TIERS
    eligible = [tier for tier in scheme if revenue >= as_decimal(tier["minRevenue"])]
    if not eligible:
        raise ValueError(f"No commission tier for revenue {revenue}")
    return max(eligible, key=lambda tier: as_decimal(tier["minRevenue"]))


def select_band(margin: D, bands: list[dict[str, Any]]) -> dict[str, Any] | None:
    eligible = [band for band in bands if margin >= as_decimal(band["minMargin"])]
    if not eligible:
        return None
    return max(eligible, key=lambda band: as_decimal(band["minMargin"]))


def max_penalty_for(sale: D) -> D:
    """Jobs invoiced under £150 cannot be fined more than £5."""
    if sale < SMALL_JOB_SALE:
        return SMALL_JOB_MAX_PENALTY
    return MAX_JOB_PENALTY


def progressive_relief(raw: D, *, sale: D | None = None) -> D:
    """Turn a positive RAW shortfall into the actual deduction.

    first £30 @ 100%, next £30 @ 50%, remainder @ 25%, then the job cap
    (£5 under £150 sale, otherwise £30).
    """
    if raw <= 0:
        return ZERO
    cap = max_penalty_for(sale if sale is not None else SMALL_JOB_SALE)
    first = min(raw, D("30"))
    rest = raw - first
    second = min(rest, D("30"))
    remainder = rest - second
    actual = first + (second * D("0.50")) + (remainder * D("0.25"))
    return money(min(actual, cap))


def cap_penalty(amount: D, *, sale: D = ZERO) -> D:
    if amount >= 0:
        return money(amount)
    return money(max(amount, -max_penalty_for(sale)))


@dataclass(frozen=True)
class JobCommission:
    revenue: D
    profit: D
    margin: D | None
    commission: D
    is_penalty: bool
    rate: D | None
    tier_min_revenue: D
    penalty_below_margin: D
    raw_penalty: D


def calculate_job_commission(
    revenue: Any,
    profit: Any,
    *,
    cost: Any = None,
    tiers: list[dict[str, Any]] | None = None,
) -> JobCommission:
    sale = as_decimal(revenue)
    job_profit = as_decimal(profit)
    job_cost = as_decimal(cost) if cost is not None else (sale - job_profit)
    scheme = tiers if tiers is not None else COMMISSION_TIERS
    tier = select_tier(sale if sale > 0 else ZERO, scheme)
    floor = as_decimal(tier["penaltyBelowMargin"])
    margin = exact_margin_percent(sale, job_profit)

    no_sale = sale <= 0
    is_loss = job_profit < 0
    below_floor = margin is not None and margin < floor

    raw = ZERO
    if no_sale and job_cost > 0:
        raw = money(job_cost * PENALTY_RATE_PO)
    elif (not no_sale) and (is_loss or below_floor):
        shortfall = (sale * (floor / D("100"))) - job_profit
        raw = money(shortfall) if shortfall > 0 else ZERO

    if raw > 0:
        deducted = cap_penalty(-progressive_relief(raw, sale=sale), sale=sale)
        return JobCommission(
            revenue=money(sale),
            profit=money(job_profit),
            margin=margin,
            commission=deducted,
            is_penalty=True,
            rate=None,
            tier_min_revenue=as_decimal(tier["minRevenue"]),
            penalty_below_margin=floor,
            raw_penalty=raw,
        )
    if no_sale:
        return JobCommission(
            revenue=money(sale),
            profit=money(job_profit),
            margin=margin,
            commission=ZERO,
            is_penalty=False,
            rate=None,
            tier_min_revenue=as_decimal(tier["minRevenue"]),
            penalty_below_margin=floor,
            raw_penalty=ZERO,
        )

    if margin is None:
        raise ValueError("Positive-sale commission requires a defined margin")
    band = select_band(margin, list(tier["bands"]))
    if band is None:
        raise ValueError(
            f"No commission band for margin {margin} in tier minRevenue={tier['minRevenue']}"
        )
    rate = as_decimal(band["rate"])
    return JobCommission(
        revenue=money(sale),
        profit=money(job_profit),
        margin=margin,
        commission=money(job_profit * rate),
        is_penalty=False,
        rate=rate,
        tier_min_revenue=as_decimal(tier["minRevenue"]),
        penalty_below_margin=floor,
        raw_penalty=ZERO,
    )


def attach_job_commissions(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    running_profit = ZERO
    running_commission = ZERO
    attached: list[dict[str, Any]] = []
    for row in rows:
        result = calculate_job_commission(row["sale"], row["profit"], cost=row.get("cost"))
        running_profit += row["profit"]
        running_commission += result.commission
        attached.append(
            {
                **row,
                "commission": result.commission,
                "commission_is_penalty": result.is_penalty,
                "commission_rate": result.rate,
                "running_profit": money(running_profit),
                "running_commission": money(running_commission),
            }
        )
    return attached


def sum_job_commissions(rows: list[dict[str, Any]]) -> D:
    return money(sum((as_decimal(row.get("commission")) for row in rows), ZERO))


@dataclass(frozen=True)
class MonthlyQualification:
    total_revenue: D
    total_profit: D
    total_labour: D
    total_po: D
    overall_margin: D | None
    running_commission: D
    payable_commission: D
    qualified: bool
    profit_remaining: D
    min_profit: D
    min_margin_message: D
    status: str
    coach_line: str


def _ceil_jobs(remaining: D, avg_profit: D) -> int | None:
    if avg_profit <= 0 or remaining <= 0:
        return None
    jobs = (remaining / avg_profit).to_integral_value(rounding=decimal.ROUND_CEILING)
    return int(jobs)


def coach_line_for(remaining: D, job_profits: list[D]) -> str:
    if remaining <= 0:
        return ""
    positive = [p for p in job_profits if p > 0]
    avg = money(sum(positive, ZERO) / D(len(positive))) if positive else ZERO
    jobs_needed = _ceil_jobs(remaining, avg) if avg > 0 else None
    typical_sale = money(remaining / D("0.40")) if remaining > 0 else ZERO
    if jobs_needed is not None:
        return (
            f"About {jobs_needed} more typical job{'s' if jobs_needed != 1 else ''} "
            f"(recent average profit {gbp(avg)}) — or roughly {gbp(typical_sale)} invoiced "
            f"at ~40% margin — to unlock {gbp(MONTHLY_MIN_PROFIT)} profit."
        )
    return (
        f"{gbp(remaining)} profit still needed. Roughly {gbp(typical_sale)} invoiced "
        f"at ~40% margin would unlock {gbp(MONTHLY_MIN_PROFIT)} profit."
    )


def qualify_month(
    total_revenue: Any,
    total_profit: Any,
    running_commission: Any,
    *,
    total_labour: Any = ZERO,
    total_po: Any = ZERO,
    job_profits: list[D] | None = None,
    min_profit: D = MONTHLY_MIN_PROFIT,
) -> MonthlyQualification:
    """Hard gate is month profit ≥ £11,000. Margin 25% is messaging only."""
    revenue = money(as_decimal(total_revenue))
    profit = money(as_decimal(total_profit))
    commission = money(as_decimal(running_commission))
    labour = money(as_decimal(total_labour))
    po = money(as_decimal(total_po))
    margin = exact_margin_percent(revenue, profit)
    qualified = profit >= min_profit
    remaining = money(max(ZERO, min_profit - profit))
    coach = "" if qualified else coach_line_for(remaining, job_profits or [])
    return MonthlyQualification(
        total_revenue=revenue,
        total_profit=profit,
        total_labour=labour,
        total_po=po,
        overall_margin=margin,
        running_commission=commission,
        payable_commission=commission if qualified else ZERO,
        qualified=qualified,
        profit_remaining=remaining,
        min_profit=min_profit,
        min_margin_message=MONTHLY_MIN_MARGIN_MESSAGE,
        status="QUALIFIED" if qualified else "NOT YET QUALIFIED",
        coach_line=coach,
    )
