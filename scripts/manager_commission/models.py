"""Report records. Staff money comes from the company engine, not a second calculation."""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from typing import Any

from .money import D


@dataclass
class GroupFact:
    gid: int
    reference: str
    owner_name: str
    sale: D
    po: D
    labour: D
    profit: D
    margin: D | None
    bucket: str
    reason: str
    reliable_profit: bool
    on_date: dt.date | None = None


@dataclass
class StaffResult:
    key: str
    name: str
    category_id: int
    sales: D
    profit: D
    margin: D | None
    net_running_commission: D
    qualified: bool
    profit_gate: D
    job_rows: list[dict[str, Any]]
    anomaly_rows: list[dict[str, Any]]
    contract_rows: list[dict[str, Any]]

    @property
    def group_ids(self) -> list[int]:
        return [int(row["gid"]) for row in self.job_rows]


@dataclass
class CompanySnapshot:
    company_key: str
    staff: list[StaffResult]
    miscellaneous: list[GroupFact]
    attention: list[GroupFact]
    notes: list[str] = field(default_factory=list)


@dataclass
class StaffLine:
    name: str
    sales: D
    profit: D
    margin: D | None
    net_running_commission: D
    qualified: bool
    status: str
    profit_gate: D
    contribution: D
    negative_commission: D


@dataclass
class NegativeJob:
    owner: str
    reference: str
    gid: int
    sale: D
    po: D
    labour: D
    profit: D
    margin: D | None
    staff_commission: D
    manager_impact: D
    qualified_owner: bool
    treatment: str


@dataclass
class AttentionItem:
    owner: str
    reference: str
    gid: int
    sale: D
    profit: D | None
    reason: str


@dataclass
class Reconciliation:
    qualified_staff_net: D
    unqualified_negative: D
    manager_share: D
    company_profit: D
    required_profit: D
    remaining_profit: D
    status: str
    running_bonus: D
    payable_bonus: D


@dataclass
class ManagerReport:
    company_name: str
    company_key: str
    manager_name: str
    manager_email: str
    cc_email: str
    rate: D
    month_label: str
    period_label: str
    period_id: str
    timezone: str
    staff_lines: list[StaffLine]
    staff_sales: D
    staff_profit: D
    staff_commission: D
    staff_contribution: D
    miscellaneous_sales: D
    miscellaneous_profit: D
    miscellaneous_margin: D | None
    miscellaneous_group_ids: list[int]
    company_sales: D
    company_profit: D
    company_margin: D | None
    qualified_count: int
    team_size: int
    running_bonus: D
    payable_bonus: D
    manager_qualified: bool
    manager_status: str
    remaining_profit: D
    profit_gate: D
    negative_jobs: list[NegativeJob]
    negative_staff_total: D
    negative_manager_total: D
    attention: list[AttentionItem]
    attention_value: D
    reconciliation: Reconciliation
    priorities: list[str]
    notes: list[str]
    delivery_mode: str
