#!/usr/bin/env python3
"""Central staff commission scheme: job-level rates plus monthly qualification.

Commission is calculated once per aggregated job (Group / Job), never on
invoice lines or report subtotal rows. Change rates and gates here only.
"""

from __future__ import annotations

import decimal
from dataclasses import dataclass
from typing import Any


D = decimal.Decimal
ZERO = D("0")
TWOP = D("0.01")

PENALTY_RATE_PO = D("0.20")  # Option A: 20% of the PO when there is no sale
MAX_JOB_PENALTY = D("250")  # Per-job commission minus cannot exceed this

MONTHLY_MIN_PROFIT = D("8000")
MONTHLY_MIN_MARGIN = D("25")

# Lauren (South Africa): one stepped minus from order size. No floor catch-up,
# no 20% of PO, and the UK £250 cap is unused because these amounts are smaller.
LAUREN_PENALTY_UNDER_500 = D("1.50")
LAUREN_PENALTY_500_TO_1999 = D("5.00")
LAUREN_PENALTY_2000_TO_4999 = D("10.00")
LAUREN_PENALTY_5000_PLUS = D("25.00")

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


@dataclass(frozen=True)
class CommissionProfile:
    """Staff-specific earn rates and below-floor / PO-only penalty mode.

    Sale bands and margin thresholds stay on COMMISSION_TIERS. Only the
    percentage of profit and the penalty method change per profile.
    """

    key: str
    earn_low: D
    earn_mid: D
    earn_high: D
    penalty_mode: str  # "catchup" | "stepped_order"
    max_job_penalty: D | None


UK_PROFILE = CommissionProfile(
    key="uk",
    earn_low=D("0.05"),
    earn_mid=D("0.075"),
    earn_high=D("0.10"),
    penalty_mode="catchup",
    max_job_penalty=MAX_JOB_PENALTY,
)

LAUREN_PROFILE = CommissionProfile(
    key="lauren",
    earn_low=D("0.01"),
    earn_mid=D("0.02"),
    earn_high=D("0.03"),
    penalty_mode="stepped_order",
    max_job_penalty=None,
)

STAFF_PROFILES: dict[str, CommissionProfile] = {
    "sharon": UK_PROFILE,
    "ella": UK_PROFILE,
    "lauren": LAUREN_PROFILE,
}


def profile_for_staff(name: str) -> CommissionProfile:
    return STAFF_PROFILES.get(name.strip().lower(), UK_PROFILE)


def tiers_for_profile(profile: CommissionProfile) -> list[dict[str, Any]]:
    """Clone the shared sale/margin bands with this profile's earn rates."""
    rate_map = {
        D("0"): D("0"),
        D("0.05"): profile.earn_low,
        D("0.075"): profile.earn_mid,
        D("0.10"): profile.earn_high,
    }
    remapped: list[dict[str, Any]] = []
    for tier in COMMISSION_TIERS:
        bands = []
        for band in tier["bands"]:
            rate = as_decimal(band["rate"])
            if rate not in rate_map:
                raise ValueError(f"No profile mapping for band rate {rate}")
            bands.append({**band, "rate": rate_map[rate]})
        remapped.append({**tier, "bands": bands})
    return remapped


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


def stepped_order_penalty(order_size: D) -> D:
    """Lauren: one minus from order size. Sale if invoiced, otherwise the PO.

    Under £500 −£1.50; £500–£1,999.99 −£5; £2,000–£4,999.99 −£10; £5,000+ −£25.
    No floor catch-up, no 20% of PO, no £250 cap.
    """
    size = order_size if order_size > 0 else ZERO
    if size < D("500"):
        return money(-LAUREN_PENALTY_UNDER_500)
    if size < D("2000"):
        return money(-LAUREN_PENALTY_500_TO_1999)
    if size < D("5000"):
        return money(-LAUREN_PENALTY_2000_TO_4999)
    return money(-LAUREN_PENALTY_5000_PLUS)


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
    profile: CommissionProfile | None = None,
) -> JobCommission:
    """Commission for one aggregated job.

    Default UK profile: below the tier minimum margin, the minus is the profit
    shortfall to that floor, capped at £250: 20% under £2,000, 12.5% from
    £2,000 up to £4,999.99, 10% from £5,000. No sale with a purchase order is
    20% of the PO, also capped. On jobs under £2,000, 20%–29.99% is £0.
    Positive commission is a percentage of JOB PROFIT. Maximum rate is 10%.

    Lauren profile: same sale bands and margin thresholds, earn rates 1% / 2%
    / 3%. Below the floor, or PO-only, one stepped minus from order size
    (sale, or PO if no sale). No catch-up, no 20% of PO, no £250 cap.
    """
    scheme_profile = profile or UK_PROFILE
    sale = as_decimal(revenue)
    job_profit = as_decimal(profit)
    job_cost = as_decimal(cost) if cost is not None else (sale - job_profit)
    scheme = tiers if tiers is not None else tiers_for_profile(scheme_profile)
    tier = select_tier(sale if sale > 0 else ZERO, scheme)
    floor = as_decimal(tier["penaltyBelowMargin"])
    margin = exact_margin_percent(sale, job_profit)

    no_sale = sale <= 0
    is_loss = job_profit < 0
    below_floor = margin is not None and margin < floor
    if no_sale and job_cost > 0:
        if scheme_profile.penalty_mode == "stepped_order":
            deducted = stepped_order_penalty(job_cost)
        else:
            deducted = po_only_penalty(job_cost)
    elif (not no_sale) and (is_loss or below_floor):
        if scheme_profile.penalty_mode == "stepped_order":
            deducted = stepped_order_penalty(sale)
        else:
            deducted = margin_catchup_penalty(sale, job_profit, floor)
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
    profile: CommissionProfile | None = None,
    tiers: list[dict[str, Any]] | None = None,
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
            tiers=tiers,
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
