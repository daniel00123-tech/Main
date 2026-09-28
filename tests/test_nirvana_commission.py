import datetime as dt
import decimal
import random
import unittest
from email.mime.multipart import MIMEMultipart
from pathlib import Path

from scripts.nirvana_commission.commission import (
    COMMISSION_TIERS,
    MAX_JOB_PENALTY,
    MONTHLY_MIN_PROFIT,
    SMALL_JOB_MAX_PENALTY,
    SMALL_JOB_SALE,
    attach_job_commissions,
    calculate_job_commission,
    progressive_relief,
    qualify_month,
    sum_job_commissions,
)
from scripts.nirvana_commission.contracts import (
    classify_contract_group,
    spans_more_than_months,
)
from scripts.nirvana_commission.engine import (
    build_staff_report,
    first_job,
    group_all_jobs_completed,
    group_owner_category_id,
    is_excluded_pack_category,
    is_missing_po_anomaly,
    job_group_reference,
)
from scripts.nirvana_commission.jobwatch import (
    NirvanaJobWatchClient,
    classify_doc,
    document_is_dropped,
    line_net,
    normalize_document,
)
from scripts.nirvana_commission.labour import (
    attracts_labour,
    compute_job_labour,
    group_has_iqbal_po_offset,
    paid_hours_for_day,
    po_matches_essentialz_or_iqbal,
    work_hours,
)
from scripts.nirvana_commission.mail import build_message
from scripts.nirvana_commission.render import (
    GROKBOT_CID,
    GROKBOT_MIME,
    GROKBOT_PATH,
    GROKBOT_QUOTES,
    build_email_body,
    build_full_html,
    day_subtotal,
    iter_display_rows,
    pick_quote,
    qualify_rows,
    render_contract_table,
)
from scripts.nirvana_commission.run import selected_staff, subject_for
from scripts.nirvana_commission.settings import (
    COMPANY_NAME,
    LABOUR_RATE,
    STAFF,
    TEST_OVERRIDE_TO,
    ConfigError,
    NirvanaSettings,
    delivery_for,
    load_settings,
)
from scripts.nirvana_commission.util import money

D = decimal.Decimal
ABI = 128055
AMY = 80404


def commission(revenue, profit=None, *, margin=None, cost=None) -> D:
    sale = D(str(revenue))
    if profit is None:
        if margin is None:
            raise ValueError("profit or margin required")
        job_profit = sale * D(str(margin)) / D("100")
    else:
        job_profit = D(str(profit))
    job_cost = D(str(cost)) if cost is not None else (sale - job_profit)
    return calculate_job_commission(sale, job_profit, cost=job_cost).commission


def job_id_safe(job):
    return int(job["JobId"])


def completed_job(jid, gid, created, **extra):
    stamp = created if " " in created else f"{created} 09:00:00"
    row = {
        "JobId": jid,
        "JobGroupId": gid,
        "JobGroup": f"GR/{gid}",
        "JobCategoryId": ABI,
        "Category": "Abi Clements",
        "Created": stamp,
        "Status": "Completed",
        "Resource": "Pat Engineer",
        "ResourceGroup": "Engineer",
        "Type": "Reactive",
        "PlannedStart": stamp,
        "PlannedDurationHours": "2",
        "Contact": "Harbour House",
        "Location": "Leeds",
    }
    row.update(extra)
    return row


def invoice(doc_id, job_id, when, amount, **extra):
    row = {
        "OrderType": "Invoice",
        "DocumentId": doc_id,
        "JobId": "" if job_id in (None, "") else str(job_id),
        "DocumentDate": when,
        "UnitPrice": str(amount),
        "UnitDiscount": "0",
        "LineQuantity": "1",
    }
    row.update(extra)
    return row


def purchase(doc_id, job_id, when, amount):
    return {
        "OrderType": "PurchaseOrder",
        "DocumentId": doc_id,
        "JobId": str(job_id),
        "DocumentDate": when,
        "CostPrice": str(amount),
        "UnitPrice": "0",
        "LineQuantity": "1",
        "Supplier": "City Plumbing",
    }


class RateAndTierTest(unittest.TestCase):
    def test_locked_examples(self) -> None:
        self.assertEqual(commission("1500", margin="35"), D("15.75"))
        self.assertEqual(commission("3000", margin="35"), D("42.00"))
        self.assertEqual(commission("5000", margin="35"), D("87.50"))
        self.assertEqual(commission("1500", margin="25"), D("0.00"))
        self.assertEqual(calculate_job_commission("8000", "0", cost="8000").commission, D("-30.00"))
        po_only = calculate_job_commission("0", "-664", cost="664")
        self.assertEqual(po_only.raw_penalty, D("132.80"))
        self.assertEqual(po_only.commission, D("-5.00"))
        self.assertEqual(calculate_job_commission("140", "20", cost="120").commission, D("-5.00"))
        self.assertEqual(calculate_job_commission("3000", "300", cost="2700").commission, D("-30.00"))
        self.assertEqual(calculate_job_commission("150", "0", cost="150").commission, D("-30.00"))

    def test_current_positive_rates_are_3_4_5(self) -> None:
        rates = {band["rate"] for tier in COMMISSION_TIERS for band in tier["bands"] if band["rate"] != 0}
        self.assertEqual(rates, {D("0.03"), D("0.04"), D("0.05")})

    def test_tier_boundaries_and_display_rounding(self) -> None:
        self.assertEqual(calculate_job_commission("1999.99", D("1999.99") * D("0.35")).tier_min_revenue, D("0"))
        self.assertEqual(calculate_job_commission("2000", D("2000") * D("0.35")).rate, D("0.04"))
        self.assertEqual(calculate_job_commission("5000", D("5000") * D("0.35")).tier_min_revenue, D("5000"))
        profit = D("1500") * D("0.4196")
        displayed = (profit / D("1500") * D("100")).quantize(D("0.1"), rounding=decimal.ROUND_HALF_UP)
        self.assertEqual(displayed, D("42.0"))
        self.assertEqual(calculate_job_commission("1500", profit).rate, D("0.03"))
        self.assertFalse(calculate_job_commission("1500", D("1500") * D("0.25")).is_penalty)

    def test_penalty_caps(self) -> None:
        self.assertEqual(MAX_JOB_PENALTY, D("30"))
        self.assertEqual(SMALL_JOB_SALE, D("150"))
        self.assertEqual(SMALL_JOB_MAX_PENALTY, D("5"))
        self.assertEqual(calculate_job_commission("0", "0", cost="0").commission, D("0.00"))
        self.assertEqual(progressive_relief(D("20")), D("20.00"))
        self.assertEqual(progressive_relief(D("40")), D("30.00"))


class MonthlyGateTest(unittest.TestCase):
    def test_profit_qualification_ignores_margin(self) -> None:
        self.assertEqual(MONTHLY_MIN_PROFIT, D("11000"))
        result = qualify_month("100000", "11000", "400")
        self.assertTrue(result.qualified)
        self.assertEqual(result.payable_commission, D("400.00"))
        self.assertEqual(result.coach_line, "")

    def test_not_qualified_keeps_running_commission_and_zero_payable(self) -> None:
        result = qualify_month("20000", "8000", "350", job_profits=[D("2000"), D("2000")])
        self.assertEqual(result.status, "NOT YET QUALIFIED")
        self.assertEqual(result.running_commission, D("350.00"))
        self.assertEqual(result.payable_commission, D("0.00"))
        self.assertIn("About 2 more typical jobs", result.coach_line)
        self.assertIn("£11,000", result.coach_line)
        self.assertNotIn("gate", result.coach_line.lower())


class NetAndDocumentTest(unittest.TestCase):
    def test_invoice_and_po_nets(self) -> None:
        self.assertEqual(line_net({"UnitPrice": "100", "UnitDiscount": "10", "LineQuantity": "2"}, "invoice"), D("180"))
        self.assertEqual(line_net({"CostPrice": "40", "UnitPrice": "99", "LineQuantity": "3"}, "po"), D("120"))
        self.assertEqual(line_net({"CostPrice": "0", "UnitPrice": "25", "LineQuantity": "2"}, "po"), D("50"))

    def test_quotes_dropped_and_credit_keeps_sign(self) -> None:
        self.assertEqual(classify_doc({"OrderType": "Quote"}), "quote")
        self.assertIsNone(normalize_document({"OrderType": "Quote", "UnitPrice": "10"}))
        self.assertTrue(document_is_dropped({"CancellationDate": "2026-02-01"}))
        credit = normalize_document(
            {
                "OrderType": "CreditNote",
                "DocumentId": "2",
                "JobId": "10",
                "DocumentDate": "2026-09-03",
                "lines": [{"UnitPrice": "-50", "UnitDiscount": "0", "LineQuantity": "1"}],
            }
        )
        assert credit is not None
        self.assertEqual(credit["net_ex_vat"], D("-50"))

    def test_contract_fields_are_kept(self) -> None:
        doc = normalize_document(
            {
                "OrderType": "Invoice",
                "DocumentId": "9",
                "JobId": "",
                "JobGroupId": "19524101",
                "ContractId": "379017",
                "ContractReference": "annual service contract 2026",
                "DocumentDate": "2026-09-01",
                "UnitPrice": "950",
                "LineQuantity": "1",
            }
        )
        assert doc is not None
        self.assertEqual(doc["job_id"], None)
        self.assertEqual(doc["group_id"], 19524101)
        self.assertEqual(doc["contract_id"], 379017)
        self.assertIn("annual service", doc["contract_reference"])


class LabourEngineTest(unittest.TestCase):
    def _job(self, **kwargs):
        job = {
            "JobId": kwargs.pop("JobId", 1),
            "Resource": kwargs.pop("Resource", "Pat Engineer"),
            "ResourceGroup": kwargs.pop("ResourceGroup", "Engineer"),
            "Type": kwargs.pop("Type", "Reactive"),
            "PlannedStart": kwargs.pop("PlannedStart", "2026-09-02 09:00:00"),
            "PlannedDurationHours": kwargs.pop("PlannedDurationHours", "2"),
            "Status": kwargs.pop("Status", "Completed"),
        }
        job.update(kwargs)
        return job

    def test_exempt_groups_and_unknown_groups(self) -> None:
        self.assertFalse(attracts_labour(self._job(ResourceGroup="Core Team - Office Staff")))
        self.assertFalse(attracts_labour(self._job(ResourceGroup="Subcontractor")))
        self.assertFalse(attracts_labour(self._job(ResourceGroup="Ex-Employee ")))
        self.assertFalse(attracts_labour(self._job(Resource="", ResourceGroup="")))
        self.assertFalse(attracts_labour(self._job(Resource="Essentialz Maintenance")))
        self.assertTrue(attracts_labour(self._job(ResourceGroup="Core Team - Electrical")))
        self.assertTrue(attracts_labour(self._job(ResourceGroup="1. Engineer")))
        self.assertFalse(attracts_labour(self._job(ResourceGroup="2. Subcontractor")))

    def test_day_engine_rules(self) -> None:
        self.assertEqual(paid_hours_for_day([self._job(PlannedDurationHours="0.5")])[1], D("2"))
        self.assertEqual(paid_hours_for_day([self._job(PlannedDurationHours="2")])[1], D("3"))
        self.assertEqual(paid_hours_for_day([self._job(PlannedDurationHours="9")])[1], D("8"))
        ppm = self._job(Type="PPM Visit", PlannedDurationHours="0.5")
        self.assertEqual(work_hours(ppm), D("0.5"))
        pair = paid_hours_for_day(
            [
                self._job(JobId=1, PlannedDurationHours="2", PlannedStart="2026-09-02 09:00:00"),
                self._job(JobId=2, PlannedDurationHours="2", PlannedStart="2026-09-02 11:00:00"),
            ]
        )
        self.assertEqual(sum(pair.values(), D("0")), D("4.00"))
        evening = paid_hours_for_day(
            [
                self._job(JobId=1, PlannedDurationHours="7", PlannedStart="2026-09-02 09:00:00"),
                self._job(JobId=2, PlannedDurationHours="3", PlannedStart="2026-09-02 17:30:00"),
            ]
        )
        self.assertEqual(evening[1], D("7.00"))
        self.assertEqual(evening[2], D("3.00"))
        scaled = paid_hours_for_day(
            [
                self._job(JobId=1, PlannedDurationHours="5", PlannedStart="2026-09-02 08:00:00"),
                self._job(JobId=2, PlannedDurationHours="5", PlannedStart="2026-09-02 13:00:00"),
            ]
        )
        self.assertEqual(sum(scaled.values(), D("0")), D("8.00"))

    def test_cancelled_and_iqbal(self) -> None:
        self.assertEqual(compute_job_labour([self._job(Status="Cancelled", PlannedDurationHours="4")])[1], D("0"))
        iqbal = self._job(JobId=11, Resource="GM. Iqbal Hussain - OL1", _group_id=99)
        essential = [{"kind": "po", "raw": {"Supplier": "Essentialz Maintenance Ltd (Iqbal)"}}]
        self.assertTrue(po_matches_essentialz_or_iqbal(essential[0]["raw"]))
        self.assertTrue(group_has_iqbal_po_offset(essential))
        self.assertEqual(compute_job_labour([iqbal], docs_by_group={99: essential})[11], D("0"))
        materials = [{"kind": "po", "raw": {"Supplier": "City Plumbing", "Description": "General materials"}}]
        self.assertFalse(po_matches_essentialz_or_iqbal(materials[0]["raw"]))
        kept = compute_job_labour(
            [self._job(JobId=12, Resource="GM. Iqbal Hussain - OL1", _group_id=88, PlannedDurationHours="2")],
            docs_by_group={88: materials},
        )
        self.assertEqual(kept[12], money(D("3") * LABOUR_RATE))


class OwnershipAndHoldTest(unittest.TestCase):
    def test_first_created_job_owns_the_group(self) -> None:
        members = [
            {"JobId": 20, "Created": "2026-03-02 10:00:00", "JobCategoryId": AMY},
            {"JobId": 10, "Created": "2026-03-01 09:00:00", "JobCategoryId": ABI},
        ]
        self.assertEqual(job_id_safe(first_job(members)), 10)
        self.assertEqual(group_owner_category_id(members), ABI)

    def test_ooh_and_nirvana_ppm_are_left_out(self) -> None:
        self.assertTrue(is_excluded_pack_category({"Category": "OOH Electric"}))
        self.assertTrue(is_excluded_pack_category({"Category": "Nirvana PPM"}))
        self.assertFalse(is_excluded_pack_category({"Category": "Abi Clements"}))
        members = [{"JobId": 1, "Created": "2026-03-01", "JobCategoryId": ABI, "Category": "OOH Night"}]
        self.assertIsNone(group_owner_category_id(members))

    def test_completion_hold(self) -> None:
        self.assertFalse(group_all_jobs_completed([{"JobId": 1, "Status": "Completed"}, {"JobId": 2, "Status": "Sent"}]))
        self.assertTrue(
            group_all_jobs_completed(
                [{"JobId": 1, "Status": "Completed with issues"}, {"JobId": 2, "Status": "Cancelled"}]
            )
        )

    def test_anomaly_threshold(self) -> None:
        self.assertTrue(is_missing_po_anomaly(D("250.01"), D("0")))
        self.assertFalse(is_missing_po_anomaly(D("250"), D("0")))
        self.assertFalse(is_missing_po_anomaly(D("251"), D("1")))

    def test_grouped_invoice_month_and_reference(self) -> None:
        jobs = [
            completed_job(101, 18358, "2026-02-01 09:00:00", JobGroupReference="GR/18358"),
            completed_job(102, 18358, "2026-02-02 09:00:00", JobCategoryId=AMY, Category="Amy Marshall", Resource="Office Admin", ResourceGroup="Office"),
            completed_job(201, 99, "2026-04-01 09:00:00", JobGroupReference="GR/99"),
        ]
        docs = [
            invoice("inv-1", 101, "2026-09-10", "400"),
            purchase("po-1", 102, "2026-09-08", "80"),
            invoice("inv-2", 201, "2026-09-12", "300"),
        ]
        main, anomalies, _review, contracts = build_staff_report(
            jobs=jobs,
            docs=docs,
            category_id=ABI,
            month_start=dt.date(2026, 9, 1),
            month_end=dt.date(2026, 9, 30),
            today=dt.date(2026, 9, 17),
        )
        self.assertEqual(contracts, [])
        self.assertEqual(len(main), 1)
        self.assertEqual(main[0]["reference"], "GR/18358")
        self.assertEqual(main[0]["sale"], D("400.00"))
        self.assertEqual(main[0]["cost"], D("80.00"))
        self.assertEqual(len(anomalies), 1)
        self.assertEqual(anomalies[0]["reference"], "GR/99")
        self.assertEqual(
            job_group_reference({"JobGroup": "GR/18358", "JobGroupId": 21639086}, 21639086),
            "GR/18358",
        )

    def test_open_group_and_resource_do_not_transfer_ownership(self) -> None:
        open_job = [completed_job(1, 1, "2026-02-01", Status="In Progress")]
        docs = [invoice("x", 1, "2026-09-10", "100")]
        main, anomalies, _, contracts = build_staff_report(
            jobs=open_job,
            docs=docs,
            category_id=ABI,
            month_start=dt.date(2026, 9, 1),
            month_end=dt.date(2026, 9, 30),
            today=dt.date(2026, 9, 17),
        )
        self.assertEqual(main, [])
        self.assertEqual(anomalies, [])
        self.assertEqual(contracts, [])
        owned = [completed_job(1, 5, "2026-01-02", Resource="Amy Marshall", ResourceGroup="Office", PlannedDurationHours="1")]
        docs = [invoice("i", 1, "2026-09-04", "100"), purchase("p", 1, "2026-09-04", "20")]
        abi_rows, _, _, _ = build_staff_report(
            jobs=owned, docs=docs, category_id=ABI, month_start=dt.date(2026, 9, 1), month_end=dt.date(2026, 9, 30), today=dt.date(2026, 9, 17)
        )
        amy_rows, _, _, _ = build_staff_report(
            jobs=owned, docs=docs, category_id=AMY, month_start=dt.date(2026, 9, 1), month_end=dt.date(2026, 9, 30), today=dt.date(2026, 9, 17)
        )
        self.assertEqual(len(abi_rows), 1)
        self.assertEqual(amy_rows, [])


class ContractExclusionTest(unittest.TestCase):
    def _report(self, jobs, docs):
        return build_staff_report(
            jobs=jobs,
            docs=docs,
            category_id=ABI,
            month_start=dt.date(2026, 9, 1),
            month_end=dt.date(2026, 9, 30),
            today=dt.date(2026, 9, 28),
        )

    def test_explicit_contract_id_is_excluded(self) -> None:
        jobs = [completed_job(1, 10, "2026-09-02", JobContractId=93693, Resource="")]
        docs = [invoice("c1", 1, "2026-09-10", "950"), purchase("p1", 1, "2026-09-10", "100")]
        main, anomalies, _, contracts = self._report(jobs, docs)
        self.assertEqual(main, [])
        self.assertEqual(anomalies, [])
        self.assertEqual(len(contracts), 1)
        self.assertTrue(contracts[0]["reason"].startswith("Explicit BigChange contract"))
        self.assertEqual(contracts[0]["commission"], D("0"))

    def test_twelve_jobs_over_eight_months_are_excluded(self) -> None:
        jobs = []
        for index in range(12):
            when = (dt.date(2026, 1, 5) + dt.timedelta(days=20 * index)).isoformat()
            jobs.append(completed_job(index + 1, 80, when, Resource=""))
        self.assertTrue(spans_more_than_months(dt.date(2026, 1, 5), dt.date(2026, 8, 24), 3))
        docs = [invoice("i", 12, "2026-09-12", "400"), purchase("p", 12, "2026-09-12", "50")]
        decision = classify_contract_group(jobs, [])
        self.assertTrue(decision.excluded)
        self.assertIn("12 jobs spanning", decision.reason)
        main, _, _, contracts = self._report(jobs, docs)
        self.assertEqual(main, [])
        self.assertEqual(len(contracts), 1)

    def test_twelve_jobs_over_six_weeks_are_not_excluded(self) -> None:
        jobs = [
            completed_job(index + 1, 60, (dt.date(2026, 8, 1) + dt.timedelta(days=3 * index)).isoformat(), Resource="")
            for index in range(12)
        ]
        decision = classify_contract_group(jobs, [])
        self.assertFalse(decision.excluded)
        docs = [invoice("i", 1, "2026-09-18", "2000"), purchase("p", 1, "2026-09-18", "400")]
        main, _, _, contracts = self._report(jobs, docs)
        self.assertEqual(contracts, [])
        self.assertEqual(len(main), 1)

    def test_eight_jobs_over_twelve_months_are_not_excluded_by_span(self) -> None:
        jobs = [
            completed_job(index + 1, 12, f"2025-{month:02d}-10", Resource="")
            for index, month in enumerate((10, 11, 12, 1, 3, 5, 7, 9))
        ]
        # January falls in 2026 so the activity really crosses a year.
        jobs[3]["Created"] = "2026-01-10 09:00:00"
        jobs[3]["PlannedStart"] = "2026-01-10 09:00:00"
        for job, month in zip(jobs[4:], (3, 5, 7, 9)):
            stamp = f"2026-{month:02d}-10 09:00:00"
            job["Created"] = stamp
            job["PlannedStart"] = stamp
        decision = classify_contract_group(jobs, [])
        self.assertFalse(decision.excluded)
        self.assertGreaterEqual(
            (decision.span_end.year - decision.span_start.year) * 12
            + (decision.span_end.month - decision.span_start.month),
            11,
        )

    def test_six_same_value_invoices_across_six_months_are_excluded(self) -> None:
        jobs = [completed_job(1, 70, "2026-01-10", Resource="")]
        docs = []
        for month in range(1, 7):
            docs.append(
                {
                    "kind": "invoice",
                    "document_id": f"m{month}",
                    "document_date": dt.date(2026, month, 15),
                    "net_ex_vat": D("750.00"),
                    "raw": {},
                }
            )
        decision = classify_contract_group(jobs, docs)
        self.assertTrue(decision.excluded)
        self.assertIn("6 recurring invoices of £750.00 across 6 months", decision.reason)

    def test_six_different_invoice_values_are_not_a_recurring_contract(self) -> None:
        jobs = [completed_job(1, 71, "2026-01-10", Resource="")]
        docs = [
            {
                "kind": "invoice",
                "document_id": f"d{month}",
                "document_date": dt.date(2026, month, 15),
                "net_ex_vat": D(str(700 + month)),
                "raw": {},
            }
            for month in range(1, 7)
        ]
        self.assertFalse(classify_contract_group(jobs, docs).excluded)

    def test_six_same_value_invoices_in_one_month_are_not_excluded(self) -> None:
        jobs = [completed_job(1, 72, "2026-09-01", Resource="")]
        docs = [
            {
                "kind": "invoice",
                "document_id": f"s{day}",
                "document_date": dt.date(2026, 9, day),
                "net_ex_vat": D("750.00"),
                "raw": {},
            }
            for day in range(1, 7)
        ]
        self.assertFalse(classify_contract_group(jobs, docs).excluded)

    def test_contract_row_adds_nothing_to_commission_or_qualification(self) -> None:
        contract_jobs = [completed_job(1, 90, "2026-09-02", ContractId=411893, Resource="")]
        normal_jobs = [completed_job(2, 91, "2026-09-03", Resource="")]
        docs = [
            invoice("c", 1, "2026-09-11", "8000"),
            purchase("cp", 1, "2026-09-11", "1000"),
            invoice("n", 2, "2026-09-12", "1500"),
            purchase("np", 2, "2026-09-12", "975"),
        ]
        main, anomalies, _, contracts = self._report(contract_jobs + normal_jobs, docs)
        self.assertEqual(anomalies, [])
        self.assertEqual(len(contracts), 1)
        self.assertEqual(contracts[0]["sale"], D("8000.00"))
        self.assertEqual(len(main), 1)
        self.assertEqual(main[0]["sale"], D("1500.00"))
        rows = attach_job_commissions(main)
        qualified = qualify_rows(rows)
        self.assertEqual(rows[0]["commission"], D("15.75"))
        self.assertEqual(qualified.total_revenue, D("1500.00"))
        self.assertEqual(qualified.total_profit, D("525.00"))
        self.assertEqual(qualified.running_commission, D("15.75"))
        self.assertEqual(qualified.payable_commission, D("0.00"))
        self.assertEqual(sum((row["commission"] for row in contracts), D("0")), D("0"))

    def test_group_level_contract_invoice_without_job_id_is_excluded(self) -> None:
        jobs = [completed_job(5, 19524101, "2026-09-01", Resource="")]
        docs = [
            invoice(
                "NM40899",
                "",
                "2026-09-04",
                "950",
                JobGroupId="19524101",
                ContractId="379017",
                ContractReference="annual service contract 2026",
            )
        ]
        main, anomalies, _, contracts = self._report(jobs, docs)
        self.assertEqual(main, [])
        self.assertEqual(anomalies, [])
        self.assertEqual(contracts[0]["sale"], D("950.00"))
        self.assertIn("Explicit BigChange contract", contracts[0]["reason"])
        self.assertIn("Harbour House", contracts[0]["customer_site"])

    def test_contract_sale_without_po_is_not_an_anomaly(self) -> None:
        jobs = [completed_job(8, 33, "2026-09-02", JobContractId=12, Resource="")]
        docs = [invoice("a", 8, "2026-09-09", "400")]
        main, anomalies, _, contracts = self._report(jobs, docs)
        self.assertEqual(main, [])
        self.assertEqual(anomalies, [])
        self.assertEqual(len(contracts), 1)


class HtmlAndRoutingTest(unittest.TestCase):
    def _settings(self, **overrides) -> NirvanaSettings:
        values = dict(
            auth_mode="api_key",
            base_url="https://webservice.bigchange.com/v01/services.ashx",
            api_key="test-key",
            username="user",
            password="secret",
            smtp_host="smtp.gmail.com",
            smtp_port=587,
            smtp_username="mailer",
            smtp_password="mail-secret",
            from_email="daniel.dwyer123@gmail.com",
            from_name="Daniel Dwyer",
            cc_email="daniel.dwyer@nirvana-group.co.uk",
            cache_dir=Path("/tmp/nirvana_commission"),
            test_override=True,
        )
        values.update(overrides)
        return NirvanaSettings(**values)

    def test_verified_staff_map(self) -> None:
        self.assertEqual(COMPANY_NAME, "Nirvana")
        self.assertEqual(STAFF["abi"]["category_id"], 128055)
        self.assertEqual(STAFF["amy"]["category_id"], 80404)
        self.assertEqual(STAFF["olivia"]["category_id"], 65297)
        self.assertEqual(STAFF["hazel"]["category_id"], 132027)
        self.assertEqual(STAFF["abi"]["email"], "abi.clements@nirvana-maintenance.co.uk")
        self.assertEqual(STAFF["amy"]["email"], "amy.marshall@nirvana-maintenance.co.uk")
        self.assertEqual(STAFF["olivia"]["email"], "olivia.blakeway@nirvana-maintenance.co.uk")
        self.assertEqual(STAFF["hazel"]["email"], "hazel.davey@nirvana-maintenance.co.uk")
        self.assertEqual(selected_staff("all"), ["abi", "amy", "olivia", "hazel"])
        self.assertEqual(selected_staff("abi,olivia"), ["abi", "olivia"])

    def test_delivery_override_and_permanent_routing(self) -> None:
        override = self._settings(test_override=True)
        to_email, cc_email, prefix = delivery_for(override, STAFF["olivia"])
        self.assertEqual(to_email, TEST_OVERRIDE_TO)
        self.assertEqual(cc_email, "")
        self.assertEqual(prefix, "TEST — ")
        self.assertEqual(
            subject_for("Olivia Blakeway", "September 2026", prefix),
            "TEST — Olivia Blakeway — September 2026 — Nirvana commission",
        )
        live = self._settings(test_override=False)
        for key, meta in STAFF.items():
            to_email, cc_email, prefix = delivery_for(live, meta)
            self.assertEqual(to_email, meta["email"])
            self.assertEqual(cc_email, "daniel.dwyer@nirvana-group.co.uk")
            self.assertEqual(prefix, "")
            self.assertFalse(subject_for(meta["name"], "September 2026", prefix).startswith("TEST"))

    def test_settings_ignore_other_company_credentials(self) -> None:
        with self.assertRaises(ConfigError):
            load_settings(
                {
                    "BIGCHANGE_API_KEY": "other-company",
                    "SMTP_PASSWORD": "other",
                    "NIRVANA_BIGCHANGE_API_KEY": "",
                }
            )
        loaded = load_settings(
            {
                "BIGCHANGE_API_KEY": "do-not-use",
                "NIRVANA_BIGCHANGE_AUTH_MODE": "api_key",
                "NIRVANA_BIGCHANGE_API_KEY": "nirvana-key",
                "NIRVANA_BIGCHANGE_USERNAME": "nirvana-user",
                "NIRVANA_BIGCHANGE_PASSWORD": "nirvana-pass",
                "NIRVANA_SMTP_HOST": "smtp.gmail.com",
                "NIRVANA_SMTP_PORT": "587",
                "NIRVANA_SMTP_USERNAME": "mailer",
                "NIRVANA_SMTP_PASSWORD": "mail-pass",
                "NIRVANA_SMTP_FROM_EMAIL": "daniel.dwyer123@gmail.com",
                "NIRVANA_SMTP_FROM_NAME": "Daniel Dwyer",
                "NIRVANA_SMTP_CC_EMAIL": "daniel.dwyer@nirvana-group.co.uk",
                "NIRVANA_COMMISSION_TEST_OVERRIDE": "1",
            }
        )
        self.assertEqual(loaded.api_key, "nirvana-key")
        self.assertTrue(loaded.test_override)
        self.assertNotEqual(loaded.api_key, "do-not-use")

    def test_email_has_full_report_and_no_attachment(self) -> None:
        rows = attach_job_commissions(
            [
                {
                    "date": dt.date(2026, 9, 3),
                    "reference": "GR/18358",
                    "sale": D("1500"),
                    "cost": D("600"),
                    "labour": D("112.50"),
                    "profit": D("787.50"),
                    "margin": D("52.5"),
                }
            ]
        )
        contracts = [
            {
                "reference": "GR/900",
                "customer_site": "Harbour House / Leeds",
                "job_count": 12,
                "date_span": "05/01/2026 – 24/08/2026",
                "sale": D("950.00"),
                "reason": "Explicit BigChange contract",
            }
        ]
        qualification = qualify_rows(rows)
        body = build_full_html(
            staff_name="Olivia Blakeway",
            month_label="September 2026",
            job_rows=rows,
            anomaly_rows=[],
            review_rows=[{"date": dt.date(2026, 9, 3), "reference": "GR/18358", "sale": D("1500"), "profit": D("787.50"), "margin": D("52.5"), "flags": ["Margin below 10%"]}],
            contract_rows=contracts,
            qualification=qualification,
            quote=GROKBOT_QUOTES[0],
        )
        email = build_email_body(
            staff_name="Olivia Blakeway",
            month_label="September 2026",
            first_name="Olivia",
            qualification=qualification,
            job_rows=rows,
            contract_rows=contracts,
            quote=GROKBOT_QUOTES[0],
        )
        self.assertIn("Labour", email)
        self.assertNotIn("Labor", email)
        self.assertIn("Nirvana", email)
        self.assertNotIn("£37.50", email)
        self.assertNotIn("37.50", email)
        self.assertIn("Hi Olivia", email)
        self.assertIn("Here is your September 2026 Nirvana commission pack.", email)
        self.assertIn("GR/18358", email)
        self.assertIn("Contract / recurring work excluded", email)
        self.assertIn("Explicit BigChange contract", email)
        self.assertIn("not included in commission calculations", email)
        self.assertNotIn("See attached", email)
        self.assertNotIn("see attached", email.lower())
        self.assertIn("Status: NOT YET QUALIFIED", email)
        self.assertIn("text-align:center", email)
        self.assertIn("max-width:680px", email)
        self.assertIn(f"cid:{GROKBOT_CID}", email)
        self.assertIn(f"data:{GROKBOT_MIME}", body)
        self.assertTrue(GROKBOT_PATH.read_bytes()[:3] == b"\xff\xd8\xff")
        self.assertGreaterEqual(len(GROKBOT_QUOTES), 12)
        self.assertEqual(len(set(GROKBOT_QUOTES)), len(GROKBOT_QUOTES))
        self.assertNotIn("Small jobs done well turn into a month you can be proud of.", GROKBOT_QUOTES)
        self.assertIn(pick_quote(rng=random.Random(3)), GROKBOT_QUOTES)
        contract_html = render_contract_table(contracts)
        self.assertNotIn("Commission", contract_html)
        self.assertNotIn("Run comm", contract_html)
        message, recipients = build_message(
            settings=self._settings(),
            subject="TEST — Olivia Blakeway — September 2026 — Nirvana commission",
            html_body=email,
            to_email=TEST_OVERRIDE_TO,
            cc_email="",
        )
        self.assertIsInstance(message, MIMEMultipart)
        self.assertEqual(recipients, [TEST_OVERRIDE_TO])
        self.assertNotIn("Cc", message)
        payload = message.as_string().lower()
        self.assertNotIn("content-disposition: attachment", payload)
        with self.assertRaises(ConfigError):
            build_message(
                settings=self._settings(),
                subject="nope",
                html_body=email,
                to_email="olivia.blakeway@nirvana-maintenance.co.uk",
                cc_email="",
            )

    def test_day_and_month_commission_are_sums(self) -> None:
        jobs = attach_job_commissions(
            [
                {"date": dt.date(2026, 9, 3), "reference": "GR/1", "sale": D("1500"), "cost": D("975"), "labour": D("0"), "profit": D("525")},
                {"date": dt.date(2026, 9, 3), "reference": "GR/2", "sale": D("3000"), "cost": D("2700"), "labour": D("0"), "profit": D("300")},
            ]
        )
        day = iter_display_rows(jobs)[2]
        self.assertEqual(day["commission"], D("-14.25"))
        self.assertEqual(day["commission"], sum_job_commissions(jobs))
        self.assertNotEqual(day["commission"], calculate_job_commission(D("4500"), D("825")).commission)
        self.assertIn("2 jobs", day_subtotal(dt.date(2026, 9, 3), jobs)["reference"])

    def test_client_refuses_writes(self) -> None:
        client = NirvanaJobWatchClient(self._settings())
        with self.assertRaises(Exception):
            client.post()
        with self.assertRaises(Exception):
            client.put()
        with self.assertRaises(Exception):
            client.patch()
        with self.assertRaises(Exception):
            client.delete()


if __name__ == "__main__":
    unittest.main()
