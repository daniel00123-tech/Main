"""Manager scorecard tests. Staff commission figures come from the company engines."""

from __future__ import annotations

import datetime as dt
import unittest
from decimal import Decimal
from pathlib import Path

from scripts.aquilo_commission.commission import attach_job_commissions as aquilo_attach
from scripts.aquilo_commission.engine import build_staff_report as aquilo_report
from scripts.aquilo_commission.render import qualify_rows as aquilo_qualify
from scripts.aquilo_commission.settings import STAFF as AQUILO_STAFF
from scripts.manager_commission.config import (
    CC_EMAIL,
    MANAGER_COMMISSION_RATE,
    MANAGER_MONTHLY_PROFIT_GATE_GBP,
    cc_domain_problem,
    resolve_cc,
    target_for,
)
from scripts.manager_commission.mail import (
    build_message,
    period_already_sent,
    record_sent,
    send_report,
    subject_for,
)
from scripts.manager_commission.models import CompanySnapshot, GroupFact, StaffResult
from scripts.manager_commission.money import ZERO, money
from scripts.manager_commission.nirvana import build_snapshot
from scripts.manager_commission.render import render_email
from scripts.manager_commission.scorecard import (
    assemble_report,
    manager_contribution,
    payable_bonus,
    qualification_status,
)
from scripts.nirvana_commission.commission import attach_job_commissions, calculate_job_commission
from scripts.nirvana_commission.engine import build_staff_report
from scripts.nirvana_commission.render import qualify_rows
from scripts.nirvana_commission.settings import STAFF

D = Decimal
START = dt.date(2026, 9, 1)
END = dt.date(2026, 9, 30)
TODAY = dt.date(2026, 9, 30)
ABI = int(STAFF["abi"]["category_id"])
AMY = int(STAFF["amy"]["category_id"])
OLIVIA = int(STAFF["olivia"]["category_id"])
HAZEL = int(STAFF["hazel"]["category_id"])
ISABEL = int(AQUILO_STAFF["isabel"]["category_id"])


def target():
    return target_for("Nirvana", env={})


def person(
    name: str,
    *,
    key: str = "abi",
    category_id: int = 1,
    sales: str = "0",
    profit: str = "0",
    net: str = "0",
    qualified: bool = False,
    gate: str = "11000",
    jobs: list | None = None,
    anomalies: list | None = None,
    contracts: list | None = None,
) -> StaffResult:
    return StaffResult(
        key=key,
        name=name,
        category_id=category_id,
        sales=money(sales),
        profit=money(profit),
        margin=None,
        net_running_commission=money(net),
        qualified=qualified,
        profit_gate=money(gate),
        job_rows=jobs or [],
        anomaly_rows=anomalies or [],
        contract_rows=contracts or [],
    )


def job_row(gid: int, commission: str, *, sale: str = "100", profit: str = "10", reference: str = "") -> dict:
    return {
        "gid": gid,
        "reference": reference or f"GR/{gid}",
        "sale": money(sale),
        "cost": money("0"),
        "labour": money("0"),
        "profit": money(profit),
        "margin": D("10"),
        "commission": money(commission),
    }


def report_from(staff: list[StaffResult], misc: list[GroupFact] | None = None, attention: list[GroupFact] | None = None):
    snapshot = CompanySnapshot("nirvana", staff, misc or [], attention or [])
    built = assemble_report(target(), snapshot, month_start=START, as_of=TODAY)
    return built, render_email(built, inline_email=False)


def completed(jid: int, gid: int, category: int, name: str, **extra) -> dict:
    row = {
        "JobId": jid,
        "JobGroupId": gid,
        "JobGroup": f"GR/{gid}",
        "JobCategoryId": category,
        "Category": name,
        "Created": "2026-09-02 09:00:00",
        "Status": "Completed",
        "Resource": "",
        "ResourceGroup": "",
        "Type": "Reactive",
        "PlannedStart": "2026-09-02 09:00:00",
        "PlannedDurationHours": "0",
    }
    row.update(extra)
    return row


def invoice(doc_id: str, job_id: int, amount: str, **extra) -> dict:
    row = {
        "OrderType": "Invoice",
        "DocumentId": doc_id,
        "JobId": str(job_id),
        "DocumentDate": "2026-09-15",
        "UnitPrice": amount,
        "UnitDiscount": "0",
        "LineQuantity": "1",
    }
    row.update(extra)
    return row


def purchase(doc_id: str, job_id: int, amount: str) -> dict:
    return {
        "OrderType": "PurchaseOrder",
        "DocumentId": doc_id,
        "JobId": str(job_id),
        "DocumentDate": "2026-09-15",
        "CostPrice": amount,
        "UnitPrice": "0",
        "LineQuantity": "1",
        "Supplier": "City Plumbing",
    }


class FormulaTest(unittest.TestCase):
    def test_status_labels(self) -> None:
        self.assertEqual(qualification_status(True), "Qualified")
        self.assertEqual(qualification_status(False), "Not qualified")
        self.assertNotIn(qualification_status(True), {"Short", "Met"})
        self.assertNotIn(qualification_status(False), {"Short", "Met"})

    def test_qualified_hundred_pays_twenty_five(self) -> None:
        staff = person("Olivia Blakeway", net="100", qualified=True, profit="11000", sales="20000")
        self.assertEqual(manager_contribution(staff, MANAGER_COMMISSION_RATE), D("25.00"))

    def test_unqualified_net_still_builds_the_manager_share(self) -> None:
        staff = person(
            "Amy Marshall",
            net="100",
            qualified=False,
            profit="1000",
            jobs=[job_row(1, "100")],
        )
        self.assertEqual(manager_contribution(staff, MANAGER_COMMISSION_RATE), D("25.00"))
        self.assertEqual(staff.qualified, False)

    def test_unqualified_negative_is_twenty_five_percent(self) -> None:
        staff = person(
            "Hazel Davey",
            net="-30",
            qualified=False,
            jobs=[job_row(2, "-30")],
        )
        self.assertEqual(manager_contribution(staff, MANAGER_COMMISSION_RATE), D("-7.50"))

    def test_qualified_penalty_is_inside_net_once(self) -> None:
        staff = person(
            "Abi Clements",
            net="100",
            qualified=True,
            profit="12000",
            jobs=[job_row(1, "130", sale="5000", profit="4000"), job_row(2, "-30", sale="1000", profit="100")],
        )
        contribution = manager_contribution(staff, MANAGER_COMMISSION_RATE)
        self.assertEqual(contribution, D("25.00"))
        doubled = money(staff.net_running_commission * MANAGER_COMMISSION_RATE + D("-30") * D("0.25"))
        self.assertEqual(contribution, D("25.00"))
        self.assertNotEqual(contribution, doubled)

    def test_one_qualified_and_three_unqualified(self) -> None:
        staff = [
            person("Abi Clements", key="abi", net="100", qualified=True, profit="12000", sales="30000", jobs=[job_row(1, "100")]),
            person("Amy Marshall", key="amy", category_id=2, net="80", qualified=False, profit="4000", sales="8000", jobs=[job_row(2, "80")]),
            person("Olivia Blakeway", key="olivia", category_id=3, net="-30", qualified=False, profit="500", sales="1000", jobs=[job_row(3, "-30")]),
            person("Hazel Davey", key="hazel", category_id=4, net="10", qualified=False, profit="100", sales="200", jobs=[job_row(4, "10"), job_row(5, "-30", sale="400", profit="-50")]),
        ]
        built, _html = report_from(staff)
        by_name = {line.name: line.contribution for line in built.staff_lines}
        self.assertEqual(by_name["Abi Clements"], D("25.00"))
        self.assertEqual(by_name["Amy Marshall"], D("20.00"))
        self.assertEqual(by_name["Olivia Blakeway"], D("-7.50"))
        self.assertEqual(by_name["Hazel Davey"], D("2.50"))
        self.assertEqual(built.running_bonus, D("40.00"))
        self.assertEqual(built.staff_lines[1].status, "Not qualified")
        self.assertEqual(built.qualified_count, 1)
        self.assertEqual(built.team_size, 4)

    def test_profit_just_below_and_on_the_gate(self) -> None:
        self.assertEqual(payable_bonus(D("25"), D("39999.99"), MANAGER_MONTHLY_PROFIT_GATE_GBP), ZERO)
        self.assertEqual(payable_bonus(D("25"), D("40000"), MANAGER_MONTHLY_PROFIT_GATE_GBP), D("25.00"))
        self.assertEqual(payable_bonus(D("-7.50"), D("40000"), MANAGER_MONTHLY_PROFIT_GATE_GBP), ZERO)

    def test_miscellaneous_can_clear_the_gate_without_commission(self) -> None:
        staff = [
            person("Abi Clements", net="100", qualified=True, profit="39900", sales="80000", jobs=[job_row(1, "100", sale="80000", profit="39900")]),
        ]
        misc = [
            GroupFact(9, "GR/9", "Unallocated", money("1000"), money("0"), ZERO, money("100"), None, "miscellaneous", "", True)
        ]
        below, _html = report_from(staff)
        self.assertEqual(below.company_profit, D("39900.00"))
        self.assertEqual(below.payable_bonus, ZERO)
        self.assertEqual(below.manager_status, "Not qualified")
        cleared, _html = report_from(staff, misc)
        self.assertEqual(cleared.company_profit, D("40000.00"))
        self.assertEqual(cleared.payable_bonus, D("25.00"))
        self.assertEqual(cleared.staff_contribution, D("25.00"))
        self.assertEqual(cleared.miscellaneous_group_ids, [9])
        self.assertNotIn("GR/9", cleared.staff_lines[0].name)

    def test_duplicate_group_is_rejected(self) -> None:
        row = job_row(7, "10")
        staff = [
            person("Abi Clements", jobs=[row], net="10", qualified=False),
            person("Amy Marshall", key="amy", category_id=2, jobs=[dict(row)], net="10", qualified=False),
        ]
        with self.assertRaises(ValueError):
            report_from(staff)


class NirvanaEngineTest(unittest.TestCase):
    def _jobs(self) -> tuple[list[dict], list[dict]]:
        jobs = [
            completed(1, 101, ABI, "Abi Clements"),
            completed(2, 102, ABI, "Abi Clements"),
            completed(3, 103, AMY, "Amy Marshall"),
            completed(4, 104, OLIVIA, "Olivia Blakeway"),
            completed(5, 105, 424242, "Unallocated"),
            completed(6, 106, 424242, "Unallocated"),
            completed(7, 107, ABI, "Abi Clements", ContractId=379017),
            completed(8, 108, 424242, "OOH Callout"),
            completed(9, 109, 424242, "Open work", Status="Scheduled"),
            completed(10, 101, ABI, "Abi Clements"),
        ]
        docs = [
            invoice("a", 1, "30000"),
            purchase("b", 1, "10000"),
            invoice("c", 2, "1000"),
            purchase("d", 2, "900"),
            invoice("e", 3, "1000"),
            purchase("f", 3, "900"),
            invoice("g", 4, "2000"),
            purchase("h", 4, "1000"),
            invoice("i", 5, "5000"),
            purchase("j", 5, "1000"),
            invoice("k", 6, "800"),
            invoice("l", 7, "9000"),
            purchase("m", 7, "1000"),
            invoice("n", 8, "3000"),
            purchase("o", 8, "500"),
            invoice("p", 9, "1500"),
            purchase("q", 9, "200"),
        ]
        return jobs, docs

    def test_reuses_engine_and_reconciles_groups(self) -> None:
        jobs, docs = self._jobs()
        snapshot = build_snapshot(jobs, docs, month_start=START, month_end=END, today=TODAY)
        self.assertEqual([person.key for person in snapshot.staff], ["abi", "amy", "olivia", "hazel"])

        abi_main, abi_anomalies, _review, abi_contracts = build_staff_report(
            jobs=jobs, docs=docs, category_id=ABI, month_start=START, month_end=END, today=TODAY
        )
        abi_rows = attach_job_commissions(abi_main)
        abi_qualification = qualify_rows(abi_rows)
        abi = snapshot.staff[0]
        self.assertEqual(abi.net_running_commission, abi_qualification.running_commission)
        self.assertEqual(abi.sales, abi_qualification.total_revenue)
        self.assertEqual(abi.profit, abi_qualification.total_profit)
        self.assertEqual(abi.qualified, abi_qualification.qualified)
        self.assertEqual({row["gid"] for row in abi.job_rows}, {row["gid"] for row in abi_rows})
        self.assertEqual(abi.profit_gate, D("11000.00"))
        self.assertTrue(abi.qualified)
        self.assertEqual(manager_contribution(abi, MANAGER_COMMISSION_RATE), money(abi.net_running_commission * MANAGER_COMMISSION_RATE))

        amy_main, _amy_anomalies, _review, _contracts = build_staff_report(
            jobs=jobs, docs=docs, category_id=AMY, month_start=START, month_end=END, today=TODAY
        )
        amy_rows = attach_job_commissions(amy_main)
        amy = next(person for person in snapshot.staff if person.key == "amy")
        self.assertEqual(amy.net_running_commission, qualify_rows(amy_rows).running_commission)
        self.assertFalse(amy.qualified)
        self.assertTrue(all(money(row["commission"]) < 0 for row in amy.job_rows))
        self.assertEqual(manager_contribution(amy, MANAGER_COMMISSION_RATE), money(amy.net_running_commission * MANAGER_COMMISSION_RATE))

        ids = [gid for person in snapshot.staff for gid in person.group_ids]
        misc_ids = [fact.gid for fact in snapshot.miscellaneous]
        attention_ids = [fact.gid for fact in snapshot.attention]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertFalse(set(ids) & set(misc_ids))
        self.assertFalse(set(ids) & set(attention_ids))
        self.assertFalse(set(misc_ids) & set(attention_ids))
        self.assertIn(105, misc_ids)
        self.assertNotIn(106, misc_ids)
        self.assertNotIn(107, misc_ids)
        self.assertNotIn(108, misc_ids)
        self.assertNotIn(109, misc_ids)
        self.assertTrue(any(row["gid"] == 107 for row in abi_contracts))
        self.assertTrue(any(fact.gid == 106 and fact.bucket == "anomaly" for fact in snapshot.attention))

        built, html = report_from_snapshot(snapshot)
        self.assertEqual(built.company_profit, money(sum((person.profit for person in snapshot.staff), ZERO) + sum((fact.profit for fact in snapshot.miscellaneous), ZERO)))
        self.assertEqual(built.company_sales, money(sum((person.sales for person in snapshot.staff), ZERO) + sum((fact.sale for fact in snapshot.miscellaneous), ZERO)))
        self.assertNotIn(106, built.miscellaneous_group_ids)
        self.assertNotIn(107, built.miscellaneous_group_ids)
        self.assertIn("GR/103", html)
        self.assertIn("COMPANY TOTAL", html)
        self.assertIn("Miscellaneous / Unallocated", html)
        self.assertIn("Qualified", html)
        self.assertIn("Not qualified", html)
        self.assertNotIn(">Short<", html)
        self.assertNotIn(">Met<", html)
        self.assertIn("Negative jobs for management review", html)
        self.assertIn(str(built.negative_staff_total), html.replace(",", "").replace("£", "") or "x")
        self.assertNotIn("37.50", html)
        self.assertNotIn("services.ashx", html)
        self.assertEqual(built.payable_bonus, ZERO)
        self.assertEqual(built.manager_status, "Not qualified")
        self.assertGreater(built.running_bonus, ZERO)
        self.assertEqual(len(built.priorities), 2)
        self.assertIn("GR/102", built.priorities[0])
        self.assertIn("GR/103", built.priorities[0])
        self.assertIn("Olivia Blakeway", built.priorities[1])
        self.assertNotIn("Anomalies and excluded work", html)

    def test_unallocated_profit_matches_the_engine_row(self) -> None:
        owned_jobs = [completed(1, 201, ABI, "Abi Clements")]
        owned_docs = [invoice("a", 1, "5000"), purchase("b", 1, "1000")]
        owned = build_snapshot(owned_jobs, owned_docs, month_start=START, month_end=END, today=TODAY)
        loose_jobs = [completed(1, 201, 424242, "Unallocated")]
        loose = build_snapshot(loose_jobs, owned_docs, month_start=START, month_end=END, today=TODAY)
        self.assertEqual(loose.miscellaneous[0].profit, owned.staff[0].profit)
        self.assertEqual(loose.miscellaneous[0].sale, owned.staff[0].sales)
        self.assertEqual(loose.staff[0].sales, ZERO)
        self.assertEqual(loose.miscellaneous[0].gid, 201)

    def test_inhouse_labour_keeps_a_no_po_job_out_of_anomalies(self) -> None:
        jobs = [completed(11, 110, ABI, "Abi Clements", Resource="GM - Stuart Williams", ResourceGroup="Engineer", PlannedDurationHours="2")]
        docs = [invoice("r", 11, "400")]
        main, anomalies, _review, _contracts = build_staff_report(
            jobs=jobs, docs=docs, category_id=ABI, month_start=START, month_end=END, today=TODAY
        )
        self.assertEqual(anomalies, [])
        self.assertEqual([row["gid"] for row in main], [110])
        snapshot = build_snapshot(jobs, docs, month_start=START, month_end=END, today=TODAY)
        self.assertIn(110, snapshot.staff[0].group_ids)
        self.assertNotIn(110, [fact.gid for fact in snapshot.miscellaneous])
        self.assertNotIn(110, [fact.gid for fact in snapshot.attention])


class AquiloEngineTest(unittest.TestCase):
    def test_uk_team_excludes_ooh_and_does_not_invent_south_africa(self) -> None:
        from scripts.manager_commission.aquilo import build_snapshot as build_aquilo

        jobs = [
            completed(1, 301, ISABEL, "Isabel Strong"),
            completed(2, 302, 515151, "OOH Weekend"),
            completed(3, 303, 515151, "Unallocated"),
        ]
        docs = [
            invoice("a", 1, "2000"),
            purchase("b", 1, "400"),
            invoice("c", 2, "900"),
            invoice("d", 3, "700"),
            purchase("d2", 3, "200"),
        ]
        snapshot = build_aquilo(jobs, docs, month_start=START, month_end=END, today=TODAY)
        self.assertEqual([person.key for person in snapshot.staff], ["isabel", "laura", "amy"])
        self.assertTrue(any("Kayla" in note for note in snapshot.notes))
        main, anomalies, _review = aquilo_report(
            jobs=jobs, docs=docs, category_id=ISABEL, month_start=START, month_end=END, today=TODAY
        )
        rows = aquilo_attach(main)
        qualification = aquilo_qualify(rows)
        isabel = snapshot.staff[0]
        self.assertEqual(isabel.net_running_commission, qualification.running_commission)
        self.assertEqual(isabel.profit_gate, D("11000.00"))
        self.assertEqual([fact.gid for fact in snapshot.miscellaneous], [303])
        self.assertTrue(any(fact.gid == 302 and "OOH" in fact.reason for fact in snapshot.attention))
        self.assertEqual(anomalies, [])
        no_po = [completed(4, 304, 515151, "Unallocated")]
        no_po_docs = [invoice("e", 4, "800")]
        held = build_aquilo(no_po, no_po_docs, month_start=START, month_end=END, today=TODAY)
        self.assertEqual(held.miscellaneous, [])
        self.assertTrue(any(fact.gid == 304 and fact.bucket == "anomaly" for fact in held.attention))


class DeliveryTest(unittest.TestCase):
    def test_configuration_and_blank_cc(self) -> None:
        self.assertEqual(CC_EMAIL, "daniel.dwyer@nirvana-group.uk")
        self.assertEqual(resolve_cc({}), CC_EMAIL)
        self.assertEqual(resolve_cc({"NIRVANA_SMTP_CC_EMAIL": ""}), "")
        self.assertEqual(resolve_cc({"NIRVANA_SMTP_CC_EMAIL": "person@example.com"}), "person@example.com")
        self.assertIn("does not resolve", cc_domain_problem(CC_EMAIL))
        chosen = target()
        self.assertEqual(chosen.manager_name, "Harry Thripp")
        self.assertEqual(chosen.manager_email, "daniel.dwyer123@gmail.com")
        self.assertEqual(chosen.rate, D("0.25"))
        self.assertEqual(chosen.profit_gate, D("40000"))
        self.assertEqual(chosen.delivery_mode, "preview")
        with self.assertRaises(Exception):
            target_for("Aquilo", env={})

    def test_message_has_no_attachment_and_optional_cc(self) -> None:
        built, html = report_from([person("Abi Clements", net="100", qualified=True, profit="12000")])
        root, recipients = build_message(
            from_email="daniel.dwyer123@gmail.com",
            from_name="Daniel Dwyer",
            to_email=built.manager_email,
            cc_email="",
            subject=subject_for(built),
            html_body=html,
        )
        self.assertNotIn("Cc", root)
        self.assertEqual(recipients, ["daniel.dwyer123@gmail.com"])
        self.assertEqual(
            subject_for(built),
            "Grokbot Manager Commission Scorecard — Nirvana Management — September 2026",
        )
        self.assertIn(built.period_id, html)
        for part in root.walk():
            self.assertNotIn("attachment", str(part.get("Content-Disposition") or "").lower())
        with self.assertRaises(Exception):
            build_message(
                from_email="daniel.dwyer123@gmail.com",
                from_name="Daniel Dwyer",
                to_email="abi.clements@nirvana-maintenance.co.uk",
                cc_email="",
                subject="x",
                html_body=html,
            )

    def test_preview_and_duplicate_send_are_blocked(self) -> None:
        built, html = report_from([person("Abi Clements")])
        with self.assertRaises(Exception) as blocked:
            send_report(
                built,
                html,
                smtp_host="127.0.0.1",
                smtp_port=2525,
                smtp_username="user",
                smtp_password="secret",
                from_email="daniel.dwyer123@gmail.com",
                from_name="Daniel Dwyer",
            )
        self.assertIn("preview-only", str(blocked.exception))
        ledger = Path("/tmp/manager_commission_test_ledger.json")
        if ledger.exists():
            ledger.unlink()
        record_sent(built.period_id, ledger)
        self.assertTrue(period_already_sent(built.period_id, ledger))
        built.delivery_mode = "approved"
        built.cc_email = ""
        with self.assertRaises(Exception) as duplicate:
            send_report(
                built,
                html,
                smtp_host="127.0.0.1",
                smtp_port=2525,
                smtp_username="user",
                smtp_password="secret",
                from_email="daniel.dwyer123@gmail.com",
                from_name="Daniel Dwyer",
                ledger=ledger,
            )
        self.assertIn("already sent", str(duplicate.exception))


def report_from_snapshot(snapshot: CompanySnapshot):
    built = assemble_report(target(), snapshot, month_start=START, as_of=TODAY)
    return built, render_email(built, inline_email=False)


class HtmlScorecardTest(unittest.TestCase):
    def test_negative_review_shows_the_job_and_totals(self) -> None:
        staff = [
            person(
                "Olivia Blakeway",
                key="olivia",
                net="70",
                qualified=False,
                profit="900",
                sales="1000",
                jobs=[job_row(55, "100", sale="1000", profit="400", reference="GR/55"), job_row(56, "-30", sale="200", profit="-40", reference="GR/56")],
            )
        ]
        built, html = report_from(staff)
        self.assertIn("GR/56", html)
        self.assertIn("Olivia Blakeway", html)
        self.assertIn("-£30.00", html)
        self.assertIn("-£7.50", html)
        self.assertEqual(built.negative_staff_total, D("-30.00"))
        self.assertEqual(built.negative_manager_total, D("-7.50"))
        self.assertEqual(built.running_bonus, D("17.50"))
        self.assertIn("Nirvana Management", html)
        self.assertNotIn("Anomalies and excluded work", html)
        self.assertNotIn("Harry Thripp", html)
        self.assertIn("Staff performance", html)
        self.assertIn("Manager bonus reconciliation", html)
        self.assertIn("Grokbot management priorities", html)
        self.assertIn("£11,000", html)
        self.assertIn("£40,000", html)
        self.assertEqual(built.miscellaneous_group_ids, [])
