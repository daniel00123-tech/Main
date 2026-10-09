"""Payment-boundary rounding shared by the manager layer.

Job commission amounts are already rounded by the company engine. The manager
share is rounded once per account manager, then summed.
"""

from __future__ import annotations

import decimal
from typing import Any

D = decimal.Decimal
ZERO = D("0")
TWOP = D("0.01")


def as_decimal(value: Any) -> D:
    if value in (None, ""):
        return ZERO
    if isinstance(value, D):
        return value
    try:
        return D(str(value).replace(",", "").strip())
    except (decimal.InvalidOperation, ValueError):
        return ZERO


def money(value: Any) -> D:
    return as_decimal(value).quantize(TWOP, rounding=decimal.ROUND_HALF_UP)


def gbp(value: D) -> str:
    sign = "-" if value < 0 else ""
    return f"{sign}£{abs(value):,.2f}"


def gbp_whole(value: D) -> str:
    amount = money(value)
    if amount == amount.to_integral_value():
        sign = "-" if amount < 0 else ""
        return f"{sign}£{abs(int(amount)):,}"
    return gbp(amount)


def format_margin(margin: D | None, places: str = "0.1") -> str:
    if margin is None:
        return "n/a"
    display = margin.quantize(D(places), rounding=decimal.ROUND_HALF_UP)
    return f"{display}%"


def margin_percent(sale: D, profit: D) -> D | None:
    if sale == 0:
        return None
    return profit / sale * D("100")
