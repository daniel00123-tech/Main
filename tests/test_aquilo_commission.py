import datetime as dt
import decimal
import unittest
from zoneinfo import ZoneInfo

from scripts.aquilo_commission.commission import (
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
from scripts.aquilo_commission.engine import (
    build_staff_report,
    first_job,
    group_all_jobs_completed,
    group_owner_category_id,
    is_excluded_pack_category,
    is_missing_po_anomaly,
    job_group_reference,
)
from scripts.aquilo_commission.jobwatch import (
    classify_doc,
    document_is_dropped,
    line_net,
    normalize_document,
)
from scripts.aquilo_commission.labour import (
    attracts_labour,
    compute_job_labour,
    group_has_iqbal_po_offset,
    paid_hours_for_day,
    po_matches_essentialz_or_iqbal,
    work_hours,
)
from scripts.aquilo_commission.mail import assert_preview_recipients
from scripts.aquilo_commission.render import (
    GROKBOT_CID,
    GROKBOT_PATH,
    GROKBOT_QUOTES,
    build_email_body,
    build_full_html,
    day_subtotal,
    iter_display_rows,
    pick_quote,
    qualify_rows,
)
from scripts.aquilo_commission.settings import (
    LABOUR_RATE,
    PREVIEW_TO_ALLOWLIST,
    AquiloSettings,
    ConfigError,
)
from scripts.aquilo_commission.util import money

D = decimal.Decimal
LONDON = ZoneInfo("Europe/London")


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


class RateAndTierTest(unittest.TestCase):
    def test_current_positive_rates_are_3_4_5(self) -> None:
        rates = {
            band["rate"]
            for tier in COMMISSION_TIERS
            for band in tier["bands"]
            if band["rate"] != 0
        }
        self.assertEqual(rates, {D("0.03"), D("0.04"), D("0.05")})
        self.assertNotIn(D("0.075"), rates)
        self.assertNotIn(D("0.10"), rates)

    def test_tier1_1500_at_35_percent(self) -> None:
        result = calculate_job_commission("1500", "525")
        self.assertEqual(result.commission, D("15.75"))
        self.assertEqual(result.rate, D("0.03"))
        self.assertEqual(result.tier_min_revenue, D("0"))

    def test_tier2_3000_at_35_percent(self) -> None:
        result = calculate_job_commission("3000", "1050")
        self.assertEqual(result.commission, D("42.00"))
        self.assertEqual(result.rate, D("0.04"))
        self.assertEqual(result.tier_min_revenue, D("2000"))

    def test_tier3_5000_at_35_percent(self) -> None:
        result = calculate_job_commission("5000", "1750")
        self.assertEqual(result.commission, D("87.50"))
        self.assertEqual(result.rate, D("0.05"))

    def test_1999_99_stays_tier_a(self) -> None:
        result = calculate_job_commission("1999.99", D("1999.99") * D("0.35"))
        self.assertEqual(result.tier_min_revenue, D("0"))
        self.assertEqual(result.rate, D("0.03"))

    def test_2000_uses_tier_b(self) -> None:
        result = calculate_job_commission("2000", D("2000") * D("0.35"))
        self.assertEqual(result.tier_min_revenue, D("2000"))
        self.assertEqual(result.rate, D("0.04"))

    def test_5000_uses_tier_c(self) -> None:
        result = calculate_job_commission("5000", D("5000") * D("0.35"))
        self.assertEqual(result.tier_min_revenue, D("5000"))

    def test_tier_a_dead_band_is_zero_not_penalty(self) -> None:
        result = calculate_job_commission("1500", D("1500") * D("0.25"))
        self.assertEqual(result.commission, D("0.00"))
        self.assertFalse(result.is_penalty)

    def test_tier_a_50_percent_is_5(self) -> None:
        self.assertEqual(commission("1500", margin="50"), money(D("1500") * D("0.50") * D("0.05")))

    def test_displayed_42_percent_does_not_change_band(self) -> None:
        profit = D("1500") * D("0.4196")
        displayed = (profit / D("1500") * D("100")).quantize(D("0.1"), rounding=decimal.ROUND_HALF_UP)
        self.assertEqual(displayed, D("42.0"))
        result = calculate_job_commission("1500", profit)
        self.assertEqual(result.rate, D("0.03"))


class PenaltyTest(unittest.TestCase):
    def test_hard_cap_is_30_not_100_or_250(self) -> None:
        self.assertEqual(MAX_JOB_PENALTY, D("30"))
        result = calculate_job_commission("8000", "0", cost="8000")
        self.assertEqual(result.commission, D("-30.00"))

    def test_po_only_uses_20_percent_then_the_small_job_cap(self) -> None:
        result = calculate_job_commission("0", "-664", cost="664")
        self.assertTrue(result.is_penalty)
        self.assertEqual(result.raw_penalty, D("132.80"))
        self.assertEqual(result.commission, D("-5.00"))

    def test_no_sale_no_cost_is_zero(self) -> None:
        result = calculate_job_commission("0", "0", cost="0")
        self.assertEqual(result.commission, D("0.00"))
        self.assertFalse(result.is_penalty)

    def test_small_shortfall_is_fully_deducted(self) -> None:
        # £705 at 15% (£106 profit) needs £141 to hit 20% → RAW £35 → cap −£30
        result = calculate_job_commission("705", "106", cost="599")
        self.assertEqual(result.raw_penalty, D("35.00"))
        self.assertEqual(result.commission, D("-30.00"))

    def test_progressive_relief_bands(self) -> None:
        self.assertEqual(progressive_relief(D("20")), D("20.00"))
        self.assertEqual(progressive_relief(D("30")), D("30.00"))
        # £40 → 30 + 5 = 35, then hard cap 30
        self.assertEqual(progressive_relief(D("40")), D("30.00"))
        # Without the cap the 50/25 bands would exceed £30; relief still caps.
        self.assertEqual(progressive_relief(D("200")), D("30.00"))

    def test_below_tier_floor_is_penalty(self) -> None:
        result = calculate_job_commission("3000", "300", cost="2700")
        self.assertTrue(result.is_penalty)
        self.assertEqual(result.commission, D("-30.00"))

    def test_jobs_under_150_are_capped_at_5(self) -> None:
        self.assertEqual(SMALL_JOB_SALE, D("150"))
        self.assertEqual(SMALL_JOB_MAX_PENALTY, D("5"))
        # £140 sale, £20 profit (14.3%) is £8 short of the 20% floor — cap −£5.
        result = calculate_job_commission("140", "20", cost="120")
        self.assertTrue(result.is_penalty)
        self.assertEqual(result.raw_penalty, D("8.00"))
        self.assertEqual(result.commission, D("-5.00"))
        tenner = calculate_job_commission("100", "10", cost="90")
        self.assertEqual(tenner.commission, D("-5.00"))
        just_under = calculate_job_commission("149.99", "0", cost="149.99")
        self.assertEqual(just_under.commission, D("-5.00"))

    def test_sale_of_150_keeps_the_30_cap(self) -> None:
        result = calculate_job_commission("150", "0", cost="150")
        self.assertEqual(result.commission, D("-30.00"))


class MonthlyGateTest(unittest.TestCase):
    def test_profit_gate_is_11000_and_margin_does_not_block(self) -> None:
        self.assertEqual(MONTHLY_MIN_PROFIT, D("11000"))
        # £11,000 profit on £100,000 sale = 11% margin — still qualified.
        result = qualify_month("100000", "11000", "400")
        self.assertTrue(result.qualified)
        self.assertEqual(result.status, "QUALIFIED")
        self.assertEqual(result.payable_commission, D("400.00"))
        self.assertEqual(result.coach_line, "")

    def test_not_qualified_shows_running_but_payable_is_zero(self) -> None:
        result = qualify_month("20000", "8000", "350", job_profits=[D("2000"), D("2000")])
        self.assertFalse(result.qualified)
        self.assertEqual(result.status, "NOT YET QUALIFIED")
        self.assertEqual(result.running_commission, D("350.00"))
        self.assertEqual(result.payable_commission, D("0.00"))
        self.assertEqual(result.profit_remaining, D("3000.00"))
        self.assertIn("40%", result.coach_line)
        self.assertIn("£11,000", result.coach_line)

    def test_no_sales_gate(self) -> None:
        result = qualify_month("0", "11000", "10")
        self.assertTrue(result.qualified)


class NetAndDocumentTest(unittest.TestCase):
    def test_invoice_net_subtracts_unit_discount(self) -> None:
        line = {"UnitPrice": "100", "UnitDiscount": "10", "LineQuantity": "2"}
        self.assertEqual(line_net(line, "invoice"), D("180"))

    def test_po_uses_cost_price_when_nonzero(self) -> None:
        line = {"CostPrice": "40", "UnitPrice": "99", "LineQuantity": "3"}
        self.assertEqual(line_net(line, "po"), D("120"))

    def test_po_falls_back_to_unit_price(self) -> None:
        line = {"CostPrice": "0", "UnitPrice": "25", "LineQuantity": "2"}
        self.assertEqual(line_net(line, "po"), D("50"))

    def test_quotes_are_ignored_and_cancelled_docs_dropped(self) -> None:
        self.assertEqual(classify_doc({"OrderType": "Quote"}), "quote")
        self.assertIsNone(normalize_document({"OrderType": "Quote", "UnitPrice": "10"}))
        self.assertTrue(document_is_dropped({"CancellationDate": "2026-02-01"}))
        invoice = {
            "OrderType": "Invoice",
            "DocumentId": "1",
            "JobId": "10",
            "DocumentDate": "2026-09-02",
            "UnitPrice": "100",
            "UnitDiscount": "0",
            "LineQuantity": "1",
        }
        normalised = normalize_document(invoice)
        assert normalised is not None
        self.assertEqual(normalised["kind"], "invoice")
        self.assertEqual(normalised["net_ex_vat"], D("100"))

    def test_credit_keeps_api_sign(self) -> None:
        doc = {
            "OrderType": "CreditNote",
            "DocumentId": "2",
            "JobId": "10",
            "DocumentDate": "2026-09-03",
            "lines": [{"UnitPrice": "-50", "UnitDiscount": "0", "LineQuantity": "1"}],
        }
        normalised = normalize_document(doc)
        assert normalised is not None
        self.assertEqual(normalised["net_ex_vat"], D("-50"))


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

    def test_office_subcontractor_ex_employee_and_unassigned_are_zero(self) -> None:
        jobs = [
            self._job(JobId=1, Resource="Office Admin", ResourceGroup="Office"),
            self._job(JobId=2, Resource="Essentialz Maintenance", ResourceGroup="Subcontractor"),
            self._job(JobId=3, Resource="Old Hand", ResourceGroup="Ex Employee"),
            self._job(JobId=4, Resource="", ResourceGroup=""),
        ]
        labour = compute_job_labour(jobs)
        self.assertTrue(all(value == 0 for value in labour.values()))
        self.assertFalse(attracts_labour(jobs[0]))
        self.assertFalse(attracts_labour(jobs[3]))

    def test_unknown_named_group_attracts_labour(self) -> None:
        self.assertTrue(attracts_labour(self._job(ResourceGroup="Field Team")))

    def test_numbered_aquilo_group_labels(self) -> None:
        self.assertTrue(attracts_labour(self._job(ResourceGroup="1. Engineer")))
        self.assertFalse(attracts_labour(self._job(ResourceGroup="2. Subcontractor")))
        self.assertFalse(attracts_labour(self._job(ResourceGroup="3. Office")))
        self.assertFalse(attracts_labour(self._job(ResourceGroup="4. Ex Employee")))
        mapped = attracts_labour(
            {"Resource": "z. Winston Carter", "ResourceGroup": ""},
            group_map={"z. winston carter": "2. Subcontractor"},
        )
        self.assertFalse(mapped)

    def test_single_non_ppm_short_job_is_two_hours(self) -> None:
        job = self._job(PlannedDurationHours="0.5")
        hours = paid_hours_for_day([job])
        self.assertEqual(hours[1], D("2"))

    def test_single_non_ppm_else_is_work_plus_one(self) -> None:
        job = self._job(PlannedDurationHours="2")
        hours = paid_hours_for_day([job])
        self.assertEqual(hours[1], D("3"))  # work max(2,1.5)=2 + 1

    def test_single_long_job_caps_at_eight(self) -> None:
        job = self._job(PlannedDurationHours="9")
        hours = paid_hours_for_day([job])
        self.assertEqual(hours[1], D("8"))

    def test_ppm_uses_planned_as_is(self) -> None:
        job = self._job(Type="Nirvana PPM Visit", PlannedDurationHours="0.5")
        self.assertEqual(work_hours(job), D("0.5"))
        hours = paid_hours_for_day([job])
        self.assertEqual(hours[1], D("1.5"))  # else → work + 1

    def test_multi_job_travel_and_half_day_cap(self) -> None:
        a = self._job(JobId=1, PlannedDurationHours="2", PlannedStart="2026-09-02 09:00:00")
        b = self._job(JobId=2, PlannedDurationHours="2", PlannedStart="2026-09-02 11:00:00")
        hours = paid_hours_for_day([a, b])
        self.assertEqual(sum(hours.values(), D("0")), D("4.00"))

    def test_evening_jobs_not_in_day_cap(self) -> None:
        day = self._job(JobId=1, PlannedDurationHours="7", PlannedStart="2026-09-02 09:00:00")
        eve = self._job(JobId=2, PlannedDurationHours="3", PlannedStart="2026-09-02 17:30:00")
        hours = paid_hours_for_day([day, eve])
        # sum(planned)=10 ≥ 8 → no travel. Day 7h under 8h cap. Evening uncapped.
        self.assertEqual(hours[1], D("7.00"))
        self.assertEqual(hours[2], D("3.00"))

    def test_day_bucket_scales_over_eight(self) -> None:
        a = self._job(JobId=1, PlannedDurationHours="5", PlannedStart="2026-09-02 08:00:00")
        b = self._job(JobId=2, PlannedDurationHours="5", PlannedStart="2026-09-02 13:00:00")
        hours = paid_hours_for_day([a, b])
        self.assertEqual(sum(hours.values(), D("0")), D("8.00"))

    def test_cancelled_jobs_have_no_labour(self) -> None:
        job = self._job(Status="Cancelled", PlannedDurationHours="4")
        labour = compute_job_labour([job])
        self.assertEqual(labour[1], D("0"))

    def test_iqbal_essentialz_po_zeros_iqbal_labour_keeps_po(self) -> None:
        job = self._job(
            JobId=11,
            Resource="GM. Iqbal Hussain - OL1",
            ResourceGroup="Engineer",
            _group_id=99,
        )
        docs = [
            {
                "kind": "po",
                "net_ex_vat": D("180"),
                "raw": {"Supplier": "Essentialz Maintenance Ltd (Iqbal)", "Description": "Labour"},
            }
        ]
        self.assertTrue(po_matches_essentialz_or_iqbal(docs[0]["raw"]))
        self.assertTrue(group_has_iqbal_po_offset(docs))
        labour = compute_job_labour([job], docs_by_group={99: docs})
        self.assertEqual(labour[11], D("0"))

    def test_materials_only_po_does_not_clear_iqbal_labour(self) -> None:
        job = self._job(
            JobId=12,
            Resource="GM. Iqbal Hussain - OL1",
            ResourceGroup="Engineer",
            _group_id=88,
            PlannedDurationHours="2",
        )
        docs = [
            {
                "kind": "po",
                "net_ex_vat": D("40"),
                "raw": {"Supplier": "City Plumbing", "Description": "General materials"},
            }
        ]
        self.assertFalse(po_matches_essentialz_or_iqbal(docs[0]["raw"]))
        labour = compute_job_labour([job], docs_by_group={88: docs})
        self.assertEqual(labour[12], money(D("3") * LABOUR_RATE))


class OwnershipAndHoldTest(unittest.TestCase):
    def test_first_created_job_owns_the_group(self) -> None:
        members = [
            {"JobId": 20, "Created": "2026-03-02 10:00:00", "JobCategoryId": 79850},
            {"JobId": 10, "Created": "2026-03-01 09:00:00", "JobCategoryId": 79691},
        ]
        self.assertEqual(job_id_safe(first_job(members)), 10)
        self.assertEqual(group_owner_category_id(members), 79691)

    def test_ooh_and_nirvana_ppm_are_left_out(self) -> None:
        self.assertTrue(is_excluded_pack_category({"Category": "OOH Electric"}))
        self.assertTrue(is_excluded_pack_category({"Category": "Nirvana PPM"}))
        self.assertFalse(is_excluded_pack_category({"Category": "Isabel Strong"}))
        members = [{"JobId": 1, "Created": "2026-03-01", "JobCategoryId": 79691, "Category": "OOH Night"}]
        self.assertIsNone(group_owner_category_id(members))

    def test_open_live_job_holds_the_group(self) -> None:
        members = [
            {"JobId": 1, "Status": "Completed"},
            {"JobId": 2, "Status": "Sent"},
        ]
        self.assertFalse(group_all_jobs_completed(members))

    def test_cancelled_jobs_ignored_for_completion(self) -> None:
        members = [
            {"JobId": 1, "Status": "Completed with issues"},
            {"JobId": 2, "Status": "Cancelled"},
        ]
        self.assertTrue(group_all_jobs_completed(members))

    def test_anomaly_is_sale_over_250_and_po_under_1(self) -> None:
        self.assertTrue(is_missing_po_anomaly(D("251"), D("0")))
        self.assertFalse(is_missing_po_anomaly(D("250"), D("0")))
        self.assertFalse(is_missing_po_anomaly(D("251"), D("1")))


def job_id_safe(job):
    return int(job["JobId"])


class ReportAssemblyTest(unittest.TestCase):
    def test_grouped_only_last_invoice_in_month_and_anomaly_split(self) -> None:
        jobs = [
            {
                "JobId": 101,
                "JobGroupId": 18358,
                "JobGroupReference": "GR/18358",
                "JobCategoryId": 79691,
                "Category": "Isabel Strong",
                "Created": "2026-02-01 09:00:00",
                "Status": "Completed",
                "Resource": "Pat Engineer",
                "ResourceGroup": "Engineer",
                "Type": "Reactive",
                "PlannedStart": "2026-09-01 09:00:00",
                "PlannedDurationHours": "2",
            },
            {
                "JobId": 102,
                "JobGroupId": 18358,
                "JobCategoryId": 79850,
                "Category": "Amy Bradley",
                "Created": "2026-02-02 09:00:00",
                "Status": "Completed",
                "Resource": "Office Admin",
                "ResourceGroup": "Office",
                "Type": "Reactive",
                "PlannedStart": "2026-09-01 11:00:00",
                "PlannedDurationHours": "1",
            },
            {
                "JobId": 201,
                "JobGroupId": 99,
                "JobGroupReference": "GR/99",
                "JobCategoryId": 79691,
                "Category": "Isabel Strong",
                "Created": "2026-04-01 09:00:00",
                "Status": "Completed",
                "Resource": "Pat Engineer",
                "ResourceGroup": "Engineer",
                "Type": "Reactive",
                "PlannedStart": "2026-09-05 09:00:00",
                "PlannedDurationHours": "2",
            },
        ]
        docs = [
            {
                "OrderType": "Invoice",
                "DocumentId": "inv-1",
                "JobId": "101",
                "DocumentDate": "2026-09-10",
                "UnitPrice": "400",
                "UnitDiscount": "0",
                "LineQuantity": "1",
            },
            {
                "OrderType": "PurchaseOrder",
                "DocumentId": "po-1",
                "JobId": "102",
                "DocumentDate": "2026-09-08",
                "CostPrice": "80",
                "UnitPrice": "0",
                "LineQuantity": "1",
                "Supplier": "City Plumbing",
            },
            {
                "OrderType": "Invoice",
                "DocumentId": "inv-2",
                "JobId": "201",
                "DocumentDate": "2026-09-12",
                "UnitPrice": "300",
                "UnitDiscount": "0",
                "LineQuantity": "1",
            },
        ]
        main, anomalies, _review = build_staff_report(
            jobs=jobs,
            docs=docs,
            category_id=79691,
            month_start=dt.date(2026, 9, 1),
            month_end=dt.date(2026, 9, 30),
            today=dt.date(2026, 9, 17),
        )
        self.assertEqual(len(main), 1)
        self.assertEqual(main[0]["reference"], "GR/18358")
        self.assertEqual(main[0]["sale"], D("400.00"))
        self.assertEqual(main[0]["cost"], D("80.00"))
        self.assertGreater(main[0]["labour"], 0)
        self.assertEqual(main[0]["profit"], money(main[0]["sale"] - main[0]["cost"] - main[0]["labour"]))
        self.assertEqual(len(anomalies), 1)
        self.assertEqual(anomalies[0]["reference"], "GR/99")
        self.assertIn("purchase order", anomalies[0]["reason"].lower())

    def test_open_job_or_other_month_excluded(self) -> None:
        jobs = [
            {
                "JobId": 1,
                "JobGroupId": 1,
                "JobCategoryId": 79691,
                "Category": "Isabel Strong",
                "Created": "2026-02-01",
                "Status": "In Progress",
                "Resource": "Pat",
                "ResourceGroup": "Engineer",
                "PlannedStart": "2026-09-01 09:00:00",
                "PlannedDurationHours": "2",
            }
        ]
        docs = [
            {
                "OrderType": "Invoice",
                "DocumentId": "x",
                "JobId": "1",
                "DocumentDate": "2026-09-10",
                "UnitPrice": "100",
                "LineQuantity": "1",
            }
        ]
        main, anomalies, _ = build_staff_report(
            jobs=jobs,
            docs=docs,
            category_id=79691,
            month_start=dt.date(2026, 9, 1),
            month_end=dt.date(2026, 9, 30),
            today=dt.date(2026, 9, 17),
        )
        self.assertEqual(main, [])
        self.assertEqual(anomalies, [])

    def test_job_group_string_is_the_report_reference(self) -> None:
        self.assertEqual(
            job_group_reference({"JobGroup": "GR/18358", "JobGroupId": 21639086, "Ref": "AF34531"}, 21639086),
            "GR/18358",
        )

    def test_resource_is_not_used_for_ownership(self) -> None:
        jobs = [
            {
                "JobId": 1,
                "JobGroupId": 5,
                "JobCategoryId": 79691,
                "Category": "Isabel Strong",
                "Created": "2026-01-02",
                "Status": "Completed",
                "Resource": "Amy Bradley",
                "ResourceGroup": "Office",
                "PlannedStart": "2026-09-01 09:00:00",
                "PlannedDurationHours": "1",
            }
        ]
        docs = [
            {
                "OrderType": "Invoice",
                "DocumentId": "i",
                "JobId": "1",
                "DocumentDate": "2026-09-04",
                "UnitPrice": "100",
                "LineQuantity": "1",
            },
            {
                "OrderType": "PurchaseOrder",
                "DocumentId": "p",
                "JobId": "1",
                "DocumentDate": "2026-09-04",
                "CostPrice": "20",
                "LineQuantity": "1",
            },
        ]
        main, _, _ = build_staff_report(
            jobs=jobs,
            docs=docs,
            category_id=79691,
            month_start=dt.date(2026, 9, 1),
            month_end=dt.date(2026, 9, 30),
            today=dt.date(2026, 9, 17),
        )
        self.assertEqual(len(main), 1)
        amy, _, _ = build_staff_report(
            jobs=jobs,
            docs=docs,
            category_id=79850,
            month_start=dt.date(2026, 9, 1),
            month_end=dt.date(2026, 9, 30),
            today=dt.date(2026, 9, 17),
        )
        self.assertEqual(amy, [])


class HtmlAndEmailGuardTest(unittest.TestCase):
    def test_html_uses_labour_spelling_and_scorecard(self) -> None:
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
        q = qualify_rows(rows)
        body = build_full_html(
            staff_name="Isabel Strong",
            month_label="September 2026",
            job_rows=rows,
            anomaly_rows=[],
            review_rows=[],
            qualification=q,
            preview=True,
        )
        email = build_email_body(
            staff_name="Isabel Strong",
            month_label="September 2026",
            first_name="Isabel",
            qualification=q,
            job_rows=rows,
            preview=True,
        )
        self.assertIn("Labour", body)
        self.assertNotIn("Labor", body)
        self.assertIn("Aquilo", body)
        self.assertIn("Isabel Strong", body)
        self.assertNotIn("£37.50", body)
        self.assertNotIn("37.50", body)
        self.assertIn("40.0%", body)
        self.assertIn("Grokbot quote of the day", body)
        self.assertIn("text-align:center", body)
        self.assertIn("NOT YET QUALIFIED", body)
        self.assertIn("Run profit", body)
        self.assertIn("Run comm", body)
        self.assertIn("Grokbot scorecard", body)
        self.assertIn("Your jobs this month", body)
        self.assertIn("GR/18358", body)
        self.assertNotIn("flex", body)
        self.assertNotIn("grid-template", body)
        self.assertTrue(GROKBOT_PATH.is_file())
        self.assertIn(f"cid:{GROKBOT_CID}", email)
        self.assertTrue(GROKBOT_PATH.read_bytes()[:3] == b"\xff\xd8\xff")
        self.assertIn("GR/18358", email)
        self.assertIn("Your jobs this month", email)
        self.assertIn("Hi Isabel", email)
        self.assertNotIn("The full job table is attached so the email client cannot clip", email)
        quote = pick_quote(rng=__import__("random").Random(7))
        self.assertIn(quote, GROKBOT_QUOTES)
        other = pick_quote(rng=__import__("random").Random(11))
        self.assertIn(other, GROKBOT_QUOTES)
        self.assertNotIn("does not gate", body.lower())
        self.assertNotIn("the gate", body.lower())
        self.assertIn("Day total", body)
        self.assertIn("03/09/2026 · 1 job", body)

    def test_day_summary_sums_jobs_and_does_not_recalculate_commission(self) -> None:
        jobs = attach_job_commissions(
            [
                {
                    "date": dt.date(2026, 9, 3),
                    "reference": "GR/1",
                    "sale": D("1500"),
                    "cost": D("975"),
                    "labour": D("0"),
                    "profit": D("525"),
                },
                {
                    "date": dt.date(2026, 9, 3),
                    "reference": "GR/2",
                    "sale": D("3000"),
                    "cost": D("2700"),
                    "labour": D("0"),
                    "profit": D("300"),
                },
                {
                    "date": dt.date(2026, 9, 4),
                    "reference": "GR/3",
                    "sale": D("3000"),
                    "cost": D("2700"),
                    "labour": D("0"),
                    "profit": D("300"),
                },
            ]
        )
        display = iter_display_rows(jobs)
        kinds = [row["kind"] for row in display]
        self.assertEqual(kinds, ["job", "job", "day_total", "job", "day_total"])
        day1 = display[2]
        self.assertEqual(day1["sale"], D("4500.00"))
        self.assertEqual(day1["labour"], D("0.00"))
        self.assertEqual(day1["profit"], D("825.00"))
        self.assertEqual(day1["commission"], D("-14.25"))
        self.assertEqual(day1["commission"], sum_job_commissions(jobs[:2]))
        self.assertNotEqual(day1["commission"], calculate_job_commission(D("4500"), D("825")).commission)
        self.assertIn("2 jobs", day_subtotal(dt.date(2026, 9, 3), jobs[:2])["reference"])
        html_body = build_full_html(
            staff_name="Amy Bradley",
            month_label="September 2026",
            job_rows=jobs,
            anomaly_rows=[],
            review_rows=[],
            qualification=qualify_rows(jobs),
        )
        self.assertIn("03/09/2026 · 2 jobs", html_body)
        self.assertIn("04/09/2026 · 1 job", html_body)
        self.assertIn("Day total", html_body)

    def test_commission_is_not_recalculated_on_month_total(self) -> None:
        rows = attach_job_commissions(
            [
                {"sale": D("1500"), "cost": D("975"), "profit": D("525"), "labour": D("0"), "date": dt.date(2026, 9, 1), "reference": "A"},
                {"sale": D("3000"), "cost": D("2700"), "profit": D("300"), "labour": D("0"), "date": dt.date(2026, 9, 2), "reference": "B"},
            ]
        )
        self.assertEqual(rows[0]["commission"], D("15.75"))
        self.assertEqual(rows[1]["commission"], D("-30.00"))
        self.assertEqual(sum_job_commissions(rows), D("-14.25"))
        combined = calculate_job_commission(D("4500"), D("825"), cost=D("3675")).commission
        self.assertNotEqual(sum_job_commissions(rows), combined)

    def test_preview_email_allowlist(self) -> None:
        settings = AquiloSettings(
            auth_mode="api_key",
            base_url="https://example.test",
            api_key="x",
            username="u",
            password="p",
            smtp_host="smtp.gmail.com",
            smtp_port=587,
            smtp_username="u",
            smtp_password="p",
            from_email="daniel.dwyer123@gmail.com",
            from_name="Daniel Dwyer",
            to_email="daniel.dwyer123@gmail.com",
            cc_email="daniel.dwyer@nirvana-group.co.uk",
            cache_dir=__import__("pathlib").Path("/tmp/aquilo_commission"),
            go_live=False,
        )
        to_list, cc_list = assert_preview_recipients(settings)
        self.assertEqual(to_list, ["daniel.dwyer123@gmail.com"])
        self.assertEqual(set(PREVIEW_TO_ALLOWLIST), {"daniel.dwyer123@gmail.com"})
        self.assertEqual(cc_list, ["daniel.dwyer@nirvana-group.co.uk"])
        blocked = AquiloSettings(**{**settings.__dict__, "to_email": "isabel@example.com"})
        with self.assertRaises(ConfigError):
            assert_preview_recipients(blocked)


class FinanceWindowTest(unittest.TestCase):
    def test_inclusive_range_uses_exclusive_end(self) -> None:
        start = dt.date(2026, 9, 1)
        end_inclusive = dt.date(2026, 9, 17)
        api_end = end_inclusive + dt.timedelta(days=1)
        self.assertEqual(api_end.isoformat(), "2026-09-18")
        self.assertEqual((api_end - start).days, 17)


if __name__ == "__main__":
    unittest.main()
