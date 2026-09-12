#!/usr/bin/env python3
"""Central staff commission scheme: job-level rates plus monthly qualification.

Commission is calculated once per aggregated job (Group / Job), never on
invoice lines or report subtotal rows. Change rates and gates here only.
"""

from __future__ import annotations

import decimal
from dataclasses import dataclass
from typing import Any, Literal


D = decimal.Decimal
ZERO = D("0")
TWOP = D("0.01")

PENALTY_RATE_PO = D("0.20")  # Option A: 20% of the PO when there is no sale
MAX_JOB_PENALTY = D("250")  # Per-job commission minus cannot exceed this

MONTHLY_MIN_PROFIT = D("8000")
MONTHLY_MIN_MARGIN = D("25")

# Single source of truth for the job-level scheme.
# A job matches the highest minRevenue that is <= its revenue.
# Inside a tier, a job matches the highest minMargin that is <= its exact margin.
# maxRevenue / maxMargin are documentary upper bounds (the next min is exclusive).
COMMISSION_TIERS: list[dict[str, Any]] = [
    {
        "minRevenue": D("0"),
        "maxRevenue": D("1999.99"),
        "penaltyBelowMargin": D("20"),
        "bands": [
            {"minMargin": D("20"), "maxMargin": D("29.99"), "rate": D("0")},
            {"minMargin": D("30"), "maxMargin": D("41.99"), "rate": D("0.05")},
            {"minMargin": D("42"), "maxMargin": D("49.99"), "rate": D("0.075")},
            {"minMargin": D("50"), "maxMargin": None, "rate": D("0.10")},
        ],
    },
    {
        "minRevenue": D("2000"),
        "maxRevenue": D("4999.99"),
        "penaltyBelowMargin": D("12.5"),
        "bands": [
            {"minMargin": D("12.5"), "maxMargin": D("34.99"), "rate": D("0.05")},
            {"minMargin": D("35"), "maxMargin": D("42.49"), "rate": D("0.075")},
            {"minMargin": D("42.5"), "maxMargin": None, "rate": D("0.10")},
        ],
    },
    {
        "minRevenue": D("5000"),
        "maxRevenue": None,
        "penaltyBelowMargin": D("10"),
        "bands": [
            {"minMargin": D("10"), "maxMargin": D("19.99"), "rate": D("0.05")},
            {"minMargin": D("20"), "maxMargin": D("31.99"), "rate": D("0.075")},
            {"minMargin": D("32"), "maxMargin": None, "rate": D("0.10")},
        ],
    },
]


# Lauren (South Africa): same sale bands and margin floors, 1% / 2% / 3% earn rates.
LAUREN_RATE_BY_UK_RATE = {
    D("0"): D("0"),
    D("0.05"): D("0.01"),
    D("0.075"): D("0.02"),
    D("0.10"): D("0.03"),
}

# Stepped minus from order size. Sale if invoiced; PO amount if PO-only.
LAUREN_PENALTY_STEPS: list[dict[str, D]] = [
    {"minOrder": D("0"), "minus": D("1.50")},
    {"minOrder": D("500"), "minus": D("5.00")},
    {"minOrder": D("2000"), "minus": D("10.00")},
    {"minOrder": D("5000"), "minus": D("25.00")},
]


def money(value: D) -> D:
    return value.quantize(TWOP, rounding=decimal.ROUND_HALF_UP)


def cap_penalty(amount: D) -> D:
    """A single job cannot lose more than MAX_JOB_PENALTY in commission."""
    if amount >= 0:
        return money(amount)
    return money(max(amount, -MAX_JOB_PENALTY))


def po_only_penalty(cost: D) -> D:
    """No invoice: 20% of the purchase-order value (option A), capped."""
    taxable_cost = cost if cost > 0 else ZERO
    return cap_penalty(money(-(taxable_cost * PENALTY_RATE_PO)))


def margin_catchup_penalty(sale: D, profit: D, floor_percent: D) -> D:
    """Minus equal to the profit missing to reach the tier's minimum margin.

    Capped at MAX_JOB_PENALTY. Example: £705 at 15% needs £141 to hit 20%, so −£35.
    """
    if sale <= 0:
        return ZERO
    target_profit = sale * (floor_percent / D("100"))
    shortfall = target_profit - profit
    if shortfall <= 0:
        return ZERO
    return cap_penalty(money(-shortfall))


def as_decimal(value: Any) -> D:
    if value in (None, ""):
        return ZERO
    if isinstance(value, D):
        return value
    return D(str(value))


def _tiers_with_mapped_rates(
    tiers: list[dict[str, Any]],
    rate_map: dict[D, D],
) -> list[dict[str, Any]]:
    remapped: list[dict[str, Any]] = []
    for tier in tiers:
        bands = []
        for band in tier["bands"]:
            uk_rate = as_decimal(band["rate"])
            if uk_rate not in rate_map:
                raise ValueError(f"No mapped earn rate for {uk_rate}")
            bands.append({**band, "rate": rate_map[uk_rate]})
        remapped.append({**tier, "bands": bands})
    return remapped


LAUREN_TIERS = _tiers_with_mapped_rates(COMMISSION_TIERS, LAUREN_RATE_BY_UK_RATE)


PenaltyStyle = Literal["catchup", "stepped"]


@dataclass(frozen=True)
class CommissionProfile:
    name: str
    tiers: list[dict[str, Any]]
    penalty_style: PenaltyStyle
    max_job_penalty: D | None


UK_PROFILE = CommissionProfile(
    name="uk",
    tiers=COMMISSION_TIERS,
    penalty_style="catchup",
    max_job_penalty=MAX_JOB_PENALTY,
)

LAUREN_PROFILE = CommissionProfile(
    name="lauren",
    tiers=LAUREN_TIERS,
    penalty_style="stepped",
    max_job_penalty=None,
)

PROFILES: dict[str, CommissionProfile] = {
    "uk": UK_PROFILE,
    "sharon": UK_PROFILE,
    "ella": UK_PROFILE,
    "lauren": LAUREN_PROFILE,
}


def resolve_profile(profile: str | CommissionProfile | None = None) -> CommissionProfile:
    if profile is None or profile == "":
        return UK_PROFILE
    if isinstance(profile, CommissionProfile):
        return profile
    key = str(profile).strip().lower()
    if key not in PROFILES:
        raise ValueError(f"Unknown commission profile: {profile}")
    return PROFILES[key]


def stepped_order_penalty(order_size: Any) -> D:
    """Lauren below-floor / PO-only minus from order size. No floor catch-up."""
    size = as_decimal(order_size)
    if size < 0:
        size = ZERO
    eligible = [step for step in LAUREN_PENALTY_STEPS if size >= as_decimal(step["minOrder"])]
    if not eligible:
        return money(-as_decimal(LAUREN_PENALTY_STEPS[0]["minus"]))
    step = max(eligible, key=lambda item: as_decimal(item["minOrder"]))
    return money(-as_decimal(step["minus"]))


def exact_margin_percent(revenue: D, profit: D) -> D | None:
    """Unrounded job/month margin. None when revenue is zero (undefined)."""
    if revenue == 0:
        return None
    return profit / revenue * D("100")


def select_tier(revenue: D, tiers: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Pick the revenue tier: highest minRevenue that is still <= job revenue."""
    scheme = tiers if tiers is not None else COMMISSION_TIERS
    eligible = [tier for tier in scheme if revenue >= as_decimal(tier["minRevenue"])]
    if not eligible:
        raise ValueError(f"No commission tier for revenue {revenue}")
    return max(eligible, key=lambda tier: as_decimal(tier["minRevenue"]))


def select_band(margin: D, bands: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Pick the margin band: highest minMargin that is still <= job margin."""
    eligible = [band for band in bands if margin >= as_decimal(band["minMargin"])]
    if not eligible:
        return None
    return max(eligible, key=lambda band: as_decimal(band["minMargin"]))


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


def calculate_job_commission(
    revenue: Any,
    profit: Any,
    *,
    cost: Any = None,
    tiers: list[dict[str, Any]] | None = None,
    profile: str | CommissionProfile | None = None,
) -> JobCommission:
    """Commission for one aggregated job.

    Default UK profile: below the tier minimum margin, the minus is the profit
    shortfall to that floor, capped at £250: 20% under £2,000, 12.5% from
    £2,000 up to £4,999.99, 10% from £5,000. No sale with a purchase order is
    20% of the PO, also capped. On jobs under £2,000, 20%–29.99% is £0.
    Positive commission is a percentage of JOB PROFIT. Maximum rate is 10%.

    Lauren profile: same sale bands and margin floors, earn rates 1% / 2% / 3%.
    Below-floor or PO-only uses a stepped minus from order size (sale, or PO
    if there is no sale): under £500 −£1.50; £500–£1,999.99 −£5; £2,000–
    £4,999.99 −£10; £5,000+ −£25. No floor catch-up, no 20% of the PO, no
    £250 cap.
    """
    rules = resolve_profile(profile)
    sale = as_decimal(revenue)
    job_profit = as_decimal(profit)
    job_cost = as_decimal(cost) if cost is not None else (sale - job_profit)
    scheme = tiers if tiers is not None else rules.tiers
    tier = select_tier(sale if sale > 0 else ZERO, scheme)
    floor = as_decimal(tier["penaltyBelowMargin"])
    margin = exact_margin_percent(sale, job_profit)

    no_sale = sale <= 0
    is_loss = job_profit < 0
    below_floor = margin is not None and margin < floor
    if no_sale and job_cost > 0:
        deducted = (
            stepped_order_penalty(job_cost)
            if rules.penalty_style == "stepped"
            else po_only_penalty(job_cost)
        )
    elif (not no_sale) and (is_loss or below_floor):
        deducted = (
            stepped_order_penalty(sale)
            if rules.penalty_style == "stepped"
            else margin_catchup_penalty(sale, job_profit, floor)
        )
    else:
        deducted = None
    if deducted is not None:
        return JobCommission(
            revenue=money(sale),
            profit=money(job_profit),
            margin=margin,
            commission=deducted,
            is_penalty=True,
            rate=None,
            tier_min_revenue=as_decimal(tier["minRevenue"]),
            penalty_below_margin=floor,
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
        )

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
    )


def attach_job_commissions(
    rows: list[dict[str, Any]],
    *,
    profile: str | CommissionProfile | None = None,
) -> list[dict[str, Any]]:
    """Add commission + running totals to already-aggregated job rows.

    Does not change sale, cost, profit, or displayed margin.
    Running commission includes negative (penalty) jobs.
    """
    running_profit = ZERO
    running_commission = ZERO
    attached: list[dict[str, Any]] = []
    for row in rows:
        result = calculate_job_commission(
            row["sale"],
            row["profit"],
            cost=row.get("cost"),
            profile=profile,
        )
        running_profit += row["profit"]
        running_commission += result.commission
        attached.append(
            {
                **row,
                "commission": result.commission,
                "commission_is_penalty": result.is_penalty,
                "running_profit": money(running_profit),
                "running_commission": money(running_commission),
            }
        )
    return attached


def sum_job_commissions(rows: list[dict[str, Any]]) -> D:
    """Sum stored job commissions. Never recalculate from combined totals."""
    return money(sum((as_decimal(row.get("commission")) for row in rows), ZERO))


@dataclass(frozen=True)
class MonthlyQualification:
    total_revenue: D
    total_profit: D
    overall_margin: D | None
    running_commission: D
    qualified: bool
    profit_remaining: D
    min_profit: D
    min_margin: D
    status: str
    general_message: str
    detail_message: str
    earned_message: str


def gbp(value: D) -> str:
    sign = "-" if value < 0 else ""
    return f"{sign}£{abs(value):,.2f}"


def format_margin(margin: D | None) -> str:
    if margin is None:
        return "n/a"
    display = margin.quantize(D("0.1"), rounding=decimal.ROUND_HALF_UP)
    return f"{display}%"


def qualify_month(
    total_revenue: Any,
    total_profit: Any,
    running_commission: Any,
    *,
    min_profit: D = MONTHLY_MIN_PROFIT,
    min_margin: D = MONTHLY_MIN_MARGIN,
) -> MonthlyQualification:
    """Monthly payment gate. Running commission is still shown when not qualified."""
    revenue = money(as_decimal(total_revenue))
    profit = money(as_decimal(total_profit))
    commission = money(as_decimal(running_commission))
    margin = exact_margin_percent(revenue, profit)
    profit_ok = profit >= min_profit
    margin_ok = margin is not None and margin >= min_margin
    qualified = profit_ok and margin_ok
    remaining = money(max(ZERO, min_profit - profit))

    general = (
        f"Your current commission is {gbp(commission)}. To qualify for payment you must "
        f"achieve a minimum of {gbp(min_profit)} total monthly profit and maintain an "
        f"overall monthly margin of at least {format_margin(min_margin)}."
    )
    if not profit_ok and not margin_ok:
        detail = (
            f"{gbp(remaining)} additional profit required before your commission becomes "
            f"eligible for payment. You must also maintain a minimum {format_margin(min_margin)} "
            f"overall margin."
        )
    elif profit_ok and not margin_ok:
        detail = (
            f"Profit target achieved. Your overall monthly margin must reach "
            f"{format_margin(min_margin)} before commission becomes eligible for payment."
        )
    elif margin_ok and not profit_ok:
        detail = (
            f"Margin target achieved. You require another {gbp(remaining)} profit before "
            f"commission becomes eligible for payment."
        )
    else:
        detail = ""

    earned = f"Commission Earned: {gbp(commission)}"
    return MonthlyQualification(
        total_revenue=revenue,
        total_profit=profit,
        overall_margin=margin,
        running_commission=commission,
        qualified=qualified,
        profit_remaining=remaining,
        min_profit=min_profit,
        min_margin=min_margin,
        status="COMMISSION QUALIFIED" if qualified else "NOT YET QUALIFIED",
        general_message="" if qualified else general,
        detail_message=detail,
        earned_message=earned,
    )
