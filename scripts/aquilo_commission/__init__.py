"""Aquilo account-manager commission packs.

Isolated from other companies: dedicated JobWatch client, cache, staff map,
and commission scheme. Read-only against the legacy JobWatch webservice.
"""

from .commission import (
    COMMISSION_TIERS,
    MAX_JOB_PENALTY,
    MONTHLY_MIN_PROFIT,
    SMALL_JOB_MAX_PENALTY,
    SMALL_JOB_SALE,
    SOUTH_AFRICA_MONTHLY_MIN_PROFIT,
    SOUTH_AFRICA_TIERS,
    attach_job_commissions,
    calculate_job_commission,
    monthly_min_profit_for,
    qualify_month,
    south_africa_order_penalty,
    sum_job_commissions,
)

__all__ = [
    "COMMISSION_TIERS",
    "MAX_JOB_PENALTY",
    "MONTHLY_MIN_PROFIT",
    "SMALL_JOB_MAX_PENALTY",
    "SMALL_JOB_SALE",
    "SOUTH_AFRICA_MONTHLY_MIN_PROFIT",
    "SOUTH_AFRICA_TIERS",
    "attach_job_commissions",
    "calculate_job_commission",
    "monthly_min_profit_for",
    "qualify_month",
    "south_africa_order_penalty",
    "sum_job_commissions",
]
