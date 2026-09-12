import datetime as dt
import decimal
import unittest

from scripts.staff_commission import (
    COMMISSION_TIERS,
    LAUREN_PROFILE,
    LAUREN_TIERS,
    MAX_JOB_PENALTY,
    MONTHLY_MIN_MARGIN,
    MONTHLY_MIN_PROFIT,
    PENALTY_RATE_PO,
    attach_job_commissions,
    calculate_job_commission,
    exact_margin_percent,
    margin_catchup_penalty,
    money,
    po_only_penalty,
    qualify_month,
    resolve_profile,
    stepped_order_penalty,
    sum_job_commissions,
)


D = decimal.Decimal


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


class SpecExamplesTest(unittest.TestCase):
    def test_tier1_example_1500_at_35_percent(self) -> None:
        # Revenue £1,500, cost £975, profit £525, margin 35% → £525 × 5% = £26.25
        result = calculate_job_commission("1500", "525")
        self.assertEqual(result.commission, D("26.25"))
        self.assertFalse(result.is_penalty)
        self.assertEqual(result.rate, D("0.05"))
        self.assertEqual(result.tier_min_revenue, D("0"))

    def test_tier2_example_3000_at_35_percent(self) -> None:
        # Revenue £3,000, cost £1,950, profit £1,050, margin 35% → £1,050 × 7.5% = £78.75
        result = calculate_job_commission("3000", "1050")
        self.assertEqual(result.commission, D("78.75"))
        self.assertFalse(result.is_penalty)
        self.assertEqual(result.rate, D("0.075"))
        self.assertEqual(result.tier_min_revenue, D("2000"))

    def test_tier2_penalty_example_3000_at_10_percent(self) -> None:
        # Below 12.5%: 12.5% of £3,000 is £375, profit is £300, catch-up −£75
        result = calculate_job_commission("3000", "300", cost="2700")
        self.assertEqual(result.commission, D("-75.00"))
        self.assertTrue(result.is_penalty)
        self.assertEqual(result.commission, margin_catchup_penalty(D("3000"), D("300"), D("12.5")))


class RevenueTierBoundaryTest(unittest.TestCase):
    def test_1999_99_uses_tier1_not_tier2(self) -> None:
        self.assertEqual(commission("1999.99", margin="35"), money(D("1999.99") * D("0.35") * D("0.05")))

    def test_2000_uses_tier2_not_tier1(self) -> None:
        self.assertEqual(commission("2000", margin="35"), money(D("2000") * D("0.35") * D("0.075")))

    def test_just_below_2000_still_tier1(self) -> None:
        result = calculate_job_commission("1999.995", D("1999.995") * D("0.35"))
        self.assertEqual(result.tier_min_revenue, D("0"))
        self.assertEqual(result.rate, D("0.05"))

    def test_4999_99_uses_tier2_not_tier3(self) -> None:
        self.assertEqual(commission("4999.99", margin="35"), money(D("4999.99") * D("0.35") * D("0.075")))

    def test_5000_uses_tier3_not_tier2(self) -> None:
        self.assertEqual(commission("5000", margin="35"), money(D("5000") * D("0.35") * D("0.10")))

    def test_no_tier_above_5000_max_rate_is_10_percent(self) -> None:
        result = calculate_job_commission("50000", D("50000") * D("0.90"))
        self.assertEqual(result.rate, D("0.10"))
        self.assertEqual(result.commission, money(D("50000") * D("0.90") * D("0.10")))
        self.assertEqual(result.tier_min_revenue, D("5000"))


class Tier1MarginBandsTest(unittest.TestCase):
    def test_penalty_just_below_20(self) -> None:
        self.assertEqual(
            commission("1500", margin="19.99"),
            margin_catchup_penalty(D("1500"), D("1500") * D("0.1999"), D("20")),
        )

    def test_gr573_at_15_percent_is_five_percent_of_the_sale(self) -> None:
        # £705 at 15% (£106 profit) needs £141 to hit 20% → −£35
        result = calculate_job_commission("705", "106", cost="599")
        self.assertEqual(result.commission, D("-35.00"))
        self.assertTrue(result.is_penalty)

    def test_20_00_to_29_99_is_zero_commission(self) -> None:
        result_low = calculate_job_commission("1500", D("1500") * D("0.20"))
        result_high = calculate_job_commission("1500", D("1500") * D("0.2999"))
        self.assertEqual(result_low.commission, D("0.00"))
        self.assertEqual(result_high.commission, D("0.00"))
        self.assertFalse(result_low.is_penalty)
        self.assertFalse(result_high.is_penalty)
        self.assertEqual(result_low.rate, D("0"))
        self.assertEqual(result_high.rate, D("0"))

    def test_gr545_at_20_3_percent_is_zero_not_a_penalty(self) -> None:
        # £155 sale, £123.50 PO, £31.50 profit, 20.3% — under £2,000 dead band.
        result = calculate_job_commission("155", "31.50", cost="123.50")
        self.assertEqual(result.commission, D("0.00"))
        self.assertFalse(result.is_penalty)
        self.assertGreaterEqual(result.margin, D("20"))
        self.assertLess(result.margin, D("30"))

    def test_30_00_is_5_percent_of_profit_not_penalty(self) -> None:
        self.assertEqual(commission("1500", margin="30"), money(D("1500") * D("0.30") * D("0.05")))

    def test_41_99_still_5_percent(self) -> None:
        self.assertEqual(commission("1500", margin="41.99"), money(D("1500") * D("0.4199") * D("0.05")))

    def test_42_00_steps_to_7_5_percent(self) -> None:
        self.assertEqual(commission("1500", margin="42"), money(D("1500") * D("0.42") * D("0.075")))

    def test_49_99_still_7_5_percent(self) -> None:
        self.assertEqual(commission("1500", margin="49.99"), money(D("1500") * D("0.4999") * D("0.075")))

    def test_50_00_steps_to_10_percent(self) -> None:
        self.assertEqual(commission("1500", margin="50"), money(D("1500") * D("0.50") * D("0.10")))

    def test_displayed_42_percent_must_not_change_band(self) -> None:
        # Exact 41.96% displays as 42.0% at 1dp, but the 7.5% band starts at 42.00 exact.
        profit = D("1500") * D("0.4196")
        displayed = (profit / D("1500") * D("100")).quantize(D("0.1"), rounding=decimal.ROUND_HALF_UP)
        self.assertEqual(displayed, D("42.0"))
        result = calculate_job_commission("1500", profit)
        self.assertEqual(result.rate, D("0.05"))


class Tier2MarginBandsTest(unittest.TestCase):
    def test_penalty_just_below_12_5(self) -> None:
        self.assertEqual(
            commission("3000", margin="12.49"),
            margin_catchup_penalty(D("3000"), D("3000") * D("0.1249"), D("12.5")),
        )

    def test_12_50_is_5_percent_of_profit_not_penalty(self) -> None:
        self.assertEqual(commission("3000", margin="12.5"), money(D("3000") * D("0.125") * D("0.05")))

    def test_15_percent_earns_not_a_minus(self) -> None:
        result = calculate_job_commission("3000", "450", cost="2550")
        self.assertEqual(result.commission, D("22.50"))
        self.assertFalse(result.is_penalty)

    def test_20_00_is_5_percent_of_profit_not_penalty(self) -> None:
        self.assertEqual(commission("3000", margin="20"), money(D("3000") * D("0.20") * D("0.05")))

    def test_34_99_still_5_percent(self) -> None:
        self.assertEqual(commission("3000", margin="34.99"), money(D("3000") * D("0.3499") * D("0.05")))

    def test_35_00_steps_to_7_5_percent(self) -> None:
        self.assertEqual(commission("3000", margin="35"), money(D("3000") * D("0.35") * D("0.075")))

    def test_42_49_still_7_5_percent(self) -> None:
        self.assertEqual(commission("3000", margin="42.49"), money(D("3000") * D("0.4249") * D("0.075")))

    def test_42_50_steps_to_10_percent(self) -> None:
        self.assertEqual(commission("3000", margin="42.5"), money(D("3000") * D("0.425") * D("0.10")))

    def test_penalty_is_the_profit_shortfall_to_12_5_percent(self) -> None:
        result = calculate_job_commission("3000", "300", cost="2700")
        self.assertEqual(result.commission, D("-75.00"))
        self.assertEqual(result.commission, margin_catchup_penalty(D("3000"), D("300"), D("12.5")))


class Tier3MarginBandsTest(unittest.TestCase):
    def test_penalty_just_below_10(self) -> None:
        self.assertEqual(
            commission("5000", margin="9.99"),
            margin_catchup_penalty(D("5000"), D("5000") * D("0.0999"), D("10")),
        )

    def test_10_00_is_5_percent_of_profit_not_penalty(self) -> None:
        self.assertEqual(commission("5000", margin="10"), money(D("5000") * D("0.10") * D("0.05")))

    def test_12_50_is_5_percent_of_profit_not_penalty(self) -> None:
        self.assertEqual(commission("5000", margin="12.5"), money(D("5000") * D("0.125") * D("0.05")))

    def test_19_99_still_5_percent(self) -> None:
        self.assertEqual(commission("5000", margin="19.99"), money(D("5000") * D("0.1999") * D("0.05")))

    def test_20_00_steps_to_7_5_percent(self) -> None:
        self.assertEqual(commission("5000", margin="20"), money(D("5000") * D("0.20") * D("0.075")))

    def test_31_99_still_7_5_percent(self) -> None:
        self.assertEqual(commission("5000", margin="31.99"), money(D("5000") * D("0.3199") * D("0.075")))

    def test_32_00_steps_to_10_percent(self) -> None:
        self.assertEqual(commission("5000", margin="32"), money(D("5000") * D("0.32") * D("0.10")))


class ZeroAndNegativeRevenueTest(unittest.TestCase):
    def test_zero_sale_with_po_penalises_20_percent_of_the_po(self) -> None:
        result = calculate_job_commission("0", "-664", cost="664")
        self.assertEqual(result.commission, D("-132.80"))
        self.assertEqual(result.commission, po_only_penalty(D("664")))
        self.assertTrue(result.is_penalty)

    def test_net_credit_job_without_po_is_zero_commission(self) -> None:
        result = calculate_job_commission("-400", "-400", cost="0")
        self.assertEqual(result.commission, D("0.00"))
        self.assertFalse(result.is_penalty)

    def test_loss_catchup_is_capped_at_250(self) -> None:
        # £35 sale, −£420 profit would be −£427 uncapped; per-job minus stops at £250.
        result = calculate_job_commission("35", "-420", cost="455")
        self.assertEqual(result.commission, D("-250.00"))
        self.assertTrue(result.is_penalty)

    def test_large_job_catchup_is_capped_at_250(self) -> None:
        result = calculate_job_commission("8000", "0", cost="8000")
        self.assertEqual(result.commission, D("-250.00"))
        self.assertEqual(MAX_JOB_PENALTY, D("250"))

    def test_large_po_only_is_capped_at_250(self) -> None:
        result = calculate_job_commission("0", "-5000", cost="5000")
        self.assertEqual(result.commission, D("-250.00"))


class RunningCommissionAndPenaltiesTest(unittest.TestCase):
    def test_penalties_reduce_running_total_and_are_not_reset(self) -> None:
        rows = attach_job_commissions(
            [
                {"sale": D("1500"), "cost": D("975"), "profit": D("525"), "reference": "JOB1"},  # +26.25
                {"sale": D("3000"), "cost": D("1950"), "profit": D("1050"), "reference": "JOB2"},  # +78.75
                {"sale": D("3000"), "cost": D("2700"), "profit": D("300"), "reference": "JOB3"},  # -75.00
                {"sale": D("1500"), "cost": D("750"), "profit": D("750"), "reference": "JOB4"},  # 50% → +75.00
            ]
        )
        amounts = [row["commission"] for row in rows]
        self.assertEqual(amounts, [D("26.25"), D("78.75"), D("-75.00"), D("75.00")])
        self.assertEqual(rows[-1]["running_commission"], D("105.00"))
        self.assertEqual(sum_job_commissions(rows), D("105.00"))
        # Positive jobs later do not wipe earlier penalties.
        self.assertEqual(rows[2]["running_commission"], D("30.00"))

    def test_does_not_change_existing_sale_profit_fields(self) -> None:
        original = {"sale": D("1500.00"), "cost": D("975.00"), "profit": D("525.00"), "margin": D("35.0")}
        attached = attach_job_commissions([original])[0]
        self.assertEqual(attached["sale"], original["sale"])
        self.assertEqual(attached["cost"], original["cost"])
        self.assertEqual(attached["profit"], original["profit"])
        self.assertEqual(attached["margin"], original["margin"])

    def test_spec_running_example_25_60_minus_50_100(self) -> None:
        # Spec walkthrough uses stated commissions, not live rates.
        rows = [
            {"commission": D("25")},
            {"commission": D("60")},
            {"commission": D("-50")},
            {"commission": D("100")},
        ]
        self.assertEqual(sum_job_commissions(rows), D("135.00"))


class JobGroupingTest(unittest.TestCase):
    def test_commission_once_on_aggregated_job_not_per_invoice_line(self) -> None:
        # Two £1,500 invoices on one group = £3,000 job at 35% → tier 2 at 7.5%.
        # Calculating each line separately would wrongly use tier 1 at 5%.
        lines = [
            {"sale": D("1500"), "profit": D("525")},
            {"sale": D("1500"), "profit": D("525")},
        ]
        per_line = sum(calculate_job_commission(line["sale"], line["profit"]).commission for line in lines)
        aggregated = calculate_job_commission(D("3000"), D("1050")).commission
        self.assertEqual(aggregated, D("78.75"))
        self.assertEqual(per_line, D("52.50"))
        self.assertNotEqual(aggregated, per_line)

    def test_date_subtotal_must_sum_job_commissions_not_recalculate(self) -> None:
        jobs = attach_job_commissions(
            [
                {"sale": D("1500"), "profit": D("525"), "date": dt.date(2026, 8, 3)},
                {"sale": D("1500"), "profit": D("525"), "date": dt.date(2026, 8, 3)},
            ]
        )
        day_sale = jobs[0]["sale"] + jobs[1]["sale"]
        day_profit = jobs[0]["profit"] + jobs[1]["profit"]
        wrong = calculate_job_commission(day_sale, day_profit).commission
        right = sum_job_commissions(jobs)
        self.assertEqual(right, D("52.50"))
        self.assertEqual(wrong, D("78.75"))
        self.assertNotEqual(right, wrong)

    def test_month_total_row_must_not_run_the_engine_on_combined_totals(self) -> None:
        jobs = attach_job_commissions(
            [
                {"sale": D("1500"), "cost": D("975"), "profit": D("525")},
                {"sale": D("3000"), "cost": D("2700"), "profit": D("300")},
            ]
        )
        combined = calculate_job_commission(D("4500"), D("825"), cost=D("3675")).commission
        self.assertEqual(sum_job_commissions(jobs), D("-48.75"))
        self.assertNotEqual(sum_job_commissions(jobs), combined)


class MonthlyQualificationTest(unittest.TestCase):
    def test_both_targets_met_is_qualified(self) -> None:
        result = qualify_month("32000", "8000", "685.50")
        self.assertTrue(result.qualified)
        self.assertEqual(result.status, "COMMISSION QUALIFIED")
        self.assertEqual(result.profit_remaining, D("0.00"))
        self.assertEqual(result.earned_message, "Commission Earned: £685.50")
        self.assertEqual(result.general_message, "")
        self.assertEqual(result.detail_message, "")

    def test_profit_7999_99_is_not_qualified_even_with_margin(self) -> None:
        result = qualify_month("20000", "7999.99", "100")
        self.assertFalse(result.qualified)
        self.assertEqual(result.status, "NOT YET QUALIFIED")
        self.assertIn("Margin target achieved", result.detail_message)
        self.assertIn("£0.01", result.detail_message)

    def test_margin_just_below_25_is_not_qualified(self) -> None:
        # £8,000 profit on £32,001 revenue = 24.999...%
        result = qualify_month("32001", "8000", "100")
        self.assertFalse(result.qualified)
        self.assertIn("Profit target achieved", result.detail_message)
        self.assertIn("25.0%", result.detail_message)

    def test_spec_example_not_yet_qualified_short_profit_and_margin(self) -> None:
        result = qualify_month("30000", "7250", "685.50")
        self.assertFalse(result.qualified)
        self.assertEqual(result.profit_remaining, D("750.00"))
        self.assertIn("£685.50", result.general_message)
        self.assertIn("£8,000", result.general_message)
        self.assertIn("25.0%", result.general_message)
        self.assertIn("£750.00 additional profit required", result.detail_message)
        self.assertIn("25.0%", result.detail_message)
        margin = exact_margin_percent(D("30000"), D("7250"))
        self.assertEqual(margin.quantize(D("0.1"), rounding=decimal.ROUND_HALF_UP), D("24.2"))

    def test_running_commission_is_still_reported_when_not_qualified(self) -> None:
        result = qualify_month("10000", "1000", "550")
        self.assertFalse(result.qualified)
        self.assertEqual(result.running_commission, D("550.00"))
        self.assertIn("£550.00", result.general_message)

    def test_gates_live_in_central_config(self) -> None:
        self.assertEqual(MONTHLY_MIN_PROFIT, D("8000"))
        self.assertEqual(MONTHLY_MIN_MARGIN, D("25"))
        self.assertEqual(PENALTY_RATE_PO, D("0.20"))
        self.assertEqual(len(COMMISSION_TIERS), 3)
        self.assertEqual(COMMISSION_TIERS[0]["penaltyBelowMargin"], D("20"))
        self.assertEqual(COMMISSION_TIERS[1]["penaltyBelowMargin"], D("12.5"))
        self.assertEqual(COMMISSION_TIERS[2]["penaltyBelowMargin"], D("10"))
        self.assertEqual(MAX_JOB_PENALTY, D("250"))


class CentralConfigShapeTest(unittest.TestCase):
    def test_tiers_are_contiguous_and_bands_start_at_the_penalty_floor(self) -> None:
        previous_max = None
        for tier in COMMISSION_TIERS:
            min_rev = tier["minRevenue"]
            max_rev = tier["maxRevenue"]
            if previous_max is not None:
                self.assertEqual(min_rev, previous_max + D("0.01"))
            previous_max = max_rev
            bands = tier["bands"]
            self.assertEqual(bands[0]["minMargin"], tier["penaltyBelowMargin"])
            self.assertIsNone(bands[-1]["maxMargin"])
            self.assertEqual(bands[-1]["rate"], D("0.10"))


class LaurenEarnRatesTest(unittest.TestCase):
    def test_same_sale_bands_and_margin_floors_as_uk(self) -> None:
        for uk_tier, lauren_tier in zip(COMMISSION_TIERS, LAUREN_TIERS):
            self.assertEqual(uk_tier["minRevenue"], lauren_tier["minRevenue"])
            self.assertEqual(uk_tier["maxRevenue"], lauren_tier["maxRevenue"])
            self.assertEqual(uk_tier["penaltyBelowMargin"], lauren_tier["penaltyBelowMargin"])
            for uk_band, lauren_band in zip(uk_tier["bands"], lauren_tier["bands"]):
                self.assertEqual(uk_band["minMargin"], lauren_band["minMargin"])
                self.assertEqual(uk_band["maxMargin"], lauren_band["maxMargin"])

    def test_under_2000_dead_band_is_still_zero(self) -> None:
        low = calculate_job_commission("1500", D("1500") * D("0.20"), profile="lauren")
        high = calculate_job_commission("1500", D("1500") * D("0.2999"), profile="lauren")
        self.assertEqual(low.commission, D("0.00"))
        self.assertEqual(high.commission, D("0.00"))
        self.assertFalse(low.is_penalty)
        self.assertEqual(low.rate, D("0"))

    def test_under_2000_earns_1_2_3_percent(self) -> None:
        at_30 = calculate_job_commission("1500", D("1500") * D("0.30"), profile="lauren")
        at_42 = calculate_job_commission("1500", D("1500") * D("0.42"), profile="lauren")
        at_50 = calculate_job_commission("1500", D("1500") * D("0.50"), profile="lauren")
        self.assertEqual(at_30.rate, D("0.01"))
        self.assertEqual(at_42.rate, D("0.02"))
        self.assertEqual(at_50.rate, D("0.03"))
        self.assertEqual(at_30.commission, money(D("1500") * D("0.30") * D("0.01")))
        self.assertEqual(at_42.commission, money(D("1500") * D("0.42") * D("0.02")))
        self.assertEqual(at_50.commission, money(D("1500") * D("0.50") * D("0.03")))

    def test_2000_to_4999_earns_1_2_3_percent(self) -> None:
        at_12_5 = calculate_job_commission("3000", D("3000") * D("0.125"), profile="lauren")
        at_35 = calculate_job_commission("3000", D("3000") * D("0.35"), profile="lauren")
        at_42_5 = calculate_job_commission("3000", D("3000") * D("0.425"), profile="lauren")
        self.assertEqual(at_12_5.rate, D("0.01"))
        self.assertEqual(at_35.rate, D("0.02"))
        self.assertEqual(at_42_5.rate, D("0.03"))
        self.assertEqual(at_35.commission, D("21.00"))

    def test_5000_plus_earns_1_2_3_percent_and_caps_at_3(self) -> None:
        at_10 = calculate_job_commission("5000", D("5000") * D("0.10"), profile="lauren")
        at_20 = calculate_job_commission("5000", D("5000") * D("0.20"), profile="lauren")
        at_32 = calculate_job_commission("5000", D("5000") * D("0.32"), profile="lauren")
        high = calculate_job_commission("50000", D("50000") * D("0.90"), profile="lauren")
        self.assertEqual(at_10.rate, D("0.01"))
        self.assertEqual(at_20.rate, D("0.02"))
        self.assertEqual(at_32.rate, D("0.03"))
        self.assertEqual(high.rate, D("0.03"))
        self.assertEqual(high.commission, money(D("50000") * D("0.90") * D("0.03")))

    def test_spec_examples_use_lauren_rates_not_uk(self) -> None:
        self.assertEqual(calculate_job_commission("1500", "525", profile="lauren").commission, D("5.25"))
        self.assertEqual(calculate_job_commission("3000", "1050", profile="lauren").commission, D("21.00"))
        self.assertEqual(calculate_job_commission("1500", "525").commission, D("26.25"))


class LaurenSteppedPenaltyTest(unittest.TestCase):
    def test_below_floor_uses_sale_as_order_size(self) -> None:
        self.assertEqual(calculate_job_commission("400", "40", profile="lauren").commission, D("-1.50"))
        self.assertEqual(calculate_job_commission("499.99", "50", profile="lauren").commission, D("-1.50"))
        self.assertEqual(calculate_job_commission("500", "50", profile="lauren").commission, D("-5.00"))
        self.assertEqual(calculate_job_commission("1999.99", "200", profile="lauren").commission, D("-5.00"))
        self.assertEqual(calculate_job_commission("2000", "100", profile="lauren").commission, D("-10.00"))
        self.assertEqual(calculate_job_commission("4999.99", "200", profile="lauren").commission, D("-10.00"))
        self.assertEqual(calculate_job_commission("5000", "200", profile="lauren").commission, D("-25.00"))

    def test_po_only_uses_po_as_order_size(self) -> None:
        self.assertEqual(
            calculate_job_commission("0", "-400", cost="400", profile="lauren").commission,
            D("-1.50"),
        )
        self.assertEqual(
            calculate_job_commission("0", "-499.99", cost="499.99", profile="lauren").commission,
            D("-1.50"),
        )
        self.assertEqual(
            calculate_job_commission("0", "-500", cost="500", profile="lauren").commission,
            D("-5.00"),
        )
        self.assertEqual(
            calculate_job_commission("0", "-1999.99", cost="1999.99", profile="lauren").commission,
            D("-5.00"),
        )
        self.assertEqual(
            calculate_job_commission("0", "-2000", cost="2000", profile="lauren").commission,
            D("-10.00"),
        )
        self.assertEqual(
            calculate_job_commission("0", "-4999.99", cost="4999.99", profile="lauren").commission,
            D("-10.00"),
        )
        self.assertEqual(
            calculate_job_commission("0", "-5000", cost="5000", profile="lauren").commission,
            D("-25.00"),
        )
        self.assertEqual(
            calculate_job_commission("0", "-10000", cost="10000", profile="lauren").commission,
            D("-25.00"),
        )

    def test_does_not_catch_up_to_floor_or_take_20_percent_of_po(self) -> None:
        # UK catch-up on £705 at 15% is −£35; Lauren sale £705 is the £500 step.
        uk_catchup = calculate_job_commission("705", "106", cost="599")
        lauren = calculate_job_commission("705", "106", cost="599", profile="lauren")
        self.assertEqual(uk_catchup.commission, D("-35.00"))
        self.assertEqual(lauren.commission, D("-5.00"))
        self.assertEqual(lauren.commission, stepped_order_penalty(D("705")))
        self.assertNotEqual(lauren.commission, margin_catchup_penalty(D("705"), D("106"), D("20")))

        uk_po = calculate_job_commission("0", "-664", cost="664")
        lauren_po = calculate_job_commission("0", "-664", cost="664", profile="lauren")
        self.assertEqual(uk_po.commission, D("-132.80"))
        self.assertEqual(lauren_po.commission, D("-5.00"))
        self.assertEqual(lauren_po.commission, stepped_order_penalty(D("664")))
        self.assertNotEqual(lauren_po.commission, po_only_penalty(D("664")))

    def test_stepped_minus_is_not_capped_at_250_and_never_uses_flat_five(self) -> None:
        self.assertIsNone(LAUREN_PROFILE.max_job_penalty)
        self.assertEqual(stepped_order_penalty("400"), D("-1.50"))
        self.assertEqual(stepped_order_penalty("500"), D("-5.00"))
        self.assertEqual(stepped_order_penalty("2000"), D("-10.00"))
        self.assertEqual(stepped_order_penalty("5000"), D("-25.00"))
        large = calculate_job_commission("8000", "0", cost="8000", profile="lauren")
        self.assertEqual(large.commission, D("-25.00"))
        self.assertNotEqual(large.commission, D("-5.00"))
        self.assertNotEqual(large.commission, D("-250.00"))

    def test_sharon_and_ella_profiles_stay_on_uk_engine(self) -> None:
        self.assertIs(resolve_profile("sharon"), resolve_profile("uk"))
        self.assertIs(resolve_profile("ella"), resolve_profile("uk"))
        self.assertEqual(
            calculate_job_commission("0", "-5000", cost="5000", profile="sharon").commission,
            D("-250.00"),
        )
        self.assertEqual(
            calculate_job_commission("3000", "300", cost="2700", profile="ella").commission,
            D("-75.00"),
        )

    def test_running_total_uses_lauren_profile_once_per_job(self) -> None:
        rows = attach_job_commissions(
            [
                {"sale": D("1500"), "cost": D("975"), "profit": D("525"), "reference": "JOB1"},
                {"sale": D("3000"), "cost": D("2700"), "profit": D("300"), "reference": "JOB2"},
                {"sale": D("0"), "cost": D("400"), "profit": D("-400"), "reference": "JOB3"},
            ],
            profile="lauren",
        )
        self.assertEqual([row["commission"] for row in rows], [D("5.25"), D("-10.00"), D("-1.50")])
        self.assertEqual(rows[-1]["running_commission"], D("-6.25"))
        self.assertEqual(sum_job_commissions(rows), D("-6.25"))


if __name__ == "__main__":
    unittest.main()
