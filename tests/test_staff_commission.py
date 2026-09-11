import datetime as dt
import decimal
import unittest

from scripts.staff_commission import (
    KNOWN_CATEGORY_IDS,
    attach_commissions,
    build_html,
    display_margin,
    is_qualified,
    job_commission,
    margin_colour,
    month_title,
    month_totals,
)
from scripts.staff_profit_report import (
    build_owned_buckets,
    category_name_matches,
    exact_margin,
    is_anomaly,
    london_month_bounds,
)


class CommissionEngineTest(unittest.TestCase):
    def test_under_2000_catch_up_example(self) -> None:
        sale = decimal.Decimal("705")
        profit = sale * decimal.Decimal("0.15")
        po = sale - profit
        self.assertEqual(job_commission(sale, po), decimal.Decimal("-35.25"))

    def test_under_2000_bands(self) -> None:
        sale = decimal.Decimal("1000")
        self.assertEqual(job_commission(sale, decimal.Decimal("850")), decimal.Decimal("-50.00"))
        self.assertEqual(job_commission(sale, decimal.Decimal("750")), decimal.Decimal("0"))
        self.assertEqual(job_commission(sale, decimal.Decimal("650")), decimal.Decimal("17.50"))
        self.assertEqual(job_commission(sale, decimal.Decimal("550")), decimal.Decimal("33.75"))
        self.assertEqual(job_commission(sale, decimal.Decimal("400")), decimal.Decimal("60.00"))

    def test_mid_band_catch_up_and_rates(self) -> None:
        sale = decimal.Decimal("3000")
        self.assertEqual(job_commission(sale, decimal.Decimal("2800")), decimal.Decimal("-175.00"))
        self.assertEqual(job_commission(sale, decimal.Decimal("2400")), decimal.Decimal("30.00"))
        self.assertEqual(job_commission(sale, decimal.Decimal("1900")), decimal.Decimal("82.50"))
        self.assertEqual(job_commission(sale, decimal.Decimal("1600")), decimal.Decimal("140.00"))

    def test_high_band_catch_up_and_rates(self) -> None:
        sale = decimal.Decimal("8000")
        self.assertEqual(job_commission(sale, decimal.Decimal("7600")), decimal.Decimal("-250.00"))
        self.assertEqual(job_commission(sale, decimal.Decimal("7000")), decimal.Decimal("50.00"))
        self.assertEqual(job_commission(sale, decimal.Decimal("6000")), decimal.Decimal("150.00"))
        self.assertEqual(job_commission(sale, decimal.Decimal("5000")), decimal.Decimal("300.00"))

    def test_po_only_minus_is_20_percent_capped(self) -> None:
        self.assertEqual(job_commission(decimal.Decimal("0"), decimal.Decimal("100")), decimal.Decimal("-20.00"))
        self.assertEqual(job_commission(decimal.Decimal("0"), decimal.Decimal("2000")), decimal.Decimal("-250.00"))

    def test_uses_exact_margin_not_display(self) -> None:
        sale = decimal.Decimal("1000")
        profit = decimal.Decimal("299.94")
        po = sale - profit
        self.assertEqual(display_margin(exact_margin(sale, profit)), "30.0%")
        self.assertEqual(job_commission(sale, po), decimal.Decimal("0"))

    def test_day_totals_sum_stored_commissions(self) -> None:
        rows = attach_commissions(
            [
                {
                    "date": dt.date(2026, 9, 2),
                    "label": "GR/1",
                    "sale": decimal.Decimal("1000"),
                    "po": decimal.Decimal("400"),
                    "profit": decimal.Decimal("600"),
                    "margin": decimal.Decimal("60"),
                },
                {
                    "date": dt.date(2026, 9, 2),
                    "label": "GR/2",
                    "sale": decimal.Decimal("705"),
                    "po": decimal.Decimal("599.25"),
                    "profit": decimal.Decimal("105.75"),
                    "margin": decimal.Decimal("15"),
                },
            ]
        )
        totals = month_totals(rows)
        self.assertEqual(totals["commission"], rows[0]["commission"] + rows[1]["commission"])
        self.assertEqual(rows[1]["run_commission"], totals["commission"])
        self.assertEqual(rows[0]["commission"], decimal.Decimal("60.00"))
        self.assertEqual(rows[1]["commission"], decimal.Decimal("-35.25"))


class QualificationTest(unittest.TestCase):
    def test_gate(self) -> None:
        self.assertFalse(
            is_qualified({"profit": decimal.Decimal("7999.99"), "margin": decimal.Decimal("40")})
        )
        self.assertFalse(
            is_qualified({"profit": decimal.Decimal("9000"), "margin": decimal.Decimal("24.99")})
        )
        self.assertTrue(
            is_qualified({"profit": decimal.Decimal("8000"), "margin": decimal.Decimal("25")})
        )


class AppearanceTest(unittest.TestCase):
    def test_known_category_map(self) -> None:
        self.assertEqual(KNOWN_CATEGORY_IDS["sharon"], "132264")
        self.assertTrue(category_name_matches("Sharon", "A- Sharon"))
        self.assertFalse(category_name_matches("Ella", "Isabella"))

    def test_current_month_and_completion_and_owner(self) -> None:
        jobs = [
            {
                "id": 10,
                "createdAt": "2026-05-02T09:00:00+01:00",
                "categoryId": 132264,
                "jobGroupId": 7,
                "status": "completedOk",
            },
            {
                "id": 11,
                "createdAt": "2026-06-01T09:00:00+01:00",
                "categoryId": 132225,
                "jobGroupId": 7,
                "status": "completedOk",
            },
            {
                "id": 12,
                "createdAt": "2026-05-03T09:00:00+01:00",
                "categoryId": 132264,
                "jobGroupId": 8,
                "status": "scheduled",
            },
            {
                "id": 13,
                "createdAt": "2026-05-04T09:00:00+01:00",
                "categoryId": 132264,
                "status": "completedOk",
            },
        ]
        documents = [
            {
                "JobId": "10",
                "OrderType": "Invoice",
                "DocumentDate": "2026-09-04",
                "UnitPrice": "400",
                "Quantity": "1",
            },
            {
                "JobId": "11",
                "OrderType": "PurchaseOrder",
                "DocumentDate": "2026-09-05",
                "CostPrice": "100",
                "Quantity": "1",
            },
            {
                "JobId": "12",
                "OrderType": "Invoice",
                "DocumentDate": "2026-09-04",
                "UnitPrice": "500",
                "Quantity": "1",
            },
            {
                "JobId": "13",
                "OrderType": "Invoice",
                "DocumentDate": "2026-08-20",
                "UnitPrice": "300",
                "Quantity": "1",
            },
        ]
        rows, anomalies = build_owned_buckets(
            jobs,
            {7: {"id": 7, "reference": "GR/700"}, 8: {"id": 8, "reference": "GR/800"}},
            documents,
            "132264",
            dt.date(2026, 9, 1),
            dt.date(2026, 9, 30),
            dt.date(2026, 5, 1),
            dt.date(2026, 9, 10),
        )
        self.assertEqual([row["label"] for row in rows], ["GR/700"])
        self.assertEqual(rows[0]["sale"], decimal.Decimal("400"))
        self.assertEqual(rows[0]["po"], decimal.Decimal("100"))
        self.assertEqual(anomalies, [])

    def test_anomaly_sale_without_po(self) -> None:
        self.assertTrue(is_anomaly(decimal.Decimal("250.01"), decimal.Decimal("0.99")))
        self.assertFalse(is_anomaly(decimal.Decimal("250"), decimal.Decimal("0")))
        jobs = [
            {
                "id": 20,
                "createdAt": "2026-05-02T09:00:00+01:00",
                "categoryId": 132264,
                "status": "completedOk",
            }
        ]
        documents = [
            {
                "JobId": "20",
                "OrderType": "Invoice",
                "DocumentDate": "2026-09-08",
                "UnitPrice": "400",
                "Quantity": "1",
            }
        ]
        rows, anomalies = build_owned_buckets(
            jobs,
            {},
            documents,
            "132264",
            dt.date(2026, 9, 1),
            dt.date(2026, 9, 30),
            dt.date(2026, 5, 1),
            dt.date(2026, 9, 10),
        )
        self.assertEqual(rows, [])
        self.assertEqual(len(anomalies), 1)
        self.assertEqual(anomalies[0]["sale"], decimal.Decimal("400"))


class HtmlLayoutTest(unittest.TestCase):
    def test_report_layout(self) -> None:
        today = dt.date(2026, 9, 10)
        rows = attach_commissions(
            [
                {
                    "date": dt.date(2026, 9, 4),
                    "label": "GR/655",
                    "sale": decimal.Decimal("1000"),
                    "po": decimal.Decimal("400"),
                    "profit": decimal.Decimal("600"),
                    "margin": decimal.Decimal("60"),
                }
            ]
        )
        body = build_html("Sharon", month_title(today), rows, [])
        self.assertIn("Sharon — September 2026", body)
        self.assertIn("commission report", body)
        self.assertIn("font-family:Arial", body)
        self.assertIn("#1f3a5f", body)
        self.assertIn("#2e5a8f", body)
        self.assertIn("#3d6fa3", body)
        self.assertIn("#4a82b8", body)
        self.assertIn("#1b7a4a", body)
        self.assertIn("Overall profit", body)
        self.assertIn("white-space:nowrap", body)
        self.assertNotIn("table-layout:fixed", body)
        self.assertIn("line-height:26px", body)
        self.assertIn("Minimum profit required", body)
        self.assertIn("NOT&nbsp;YET&nbsp;QUALIFIED", body)
        self.assertIn("Group / job", body)
        self.assertIn("Run profit", body)
        self.assertIn("Run comm.", body)
        self.assertIn("Day total", body)
        self.assertIn("Total — 1 groups/jobs", body)
        self.assertIn("04/09/2026", body)
        self.assertNotIn("Anomalies", body)
        self.assertNotIn("flex", body.lower())
        self.assertNotIn("Below 20%", body)
        self.assertLess(body.find("Overall profit"), body.find("Invoiced"))
        self.assertLess(body.find("Invoiced"), body.find("Purchase orders"))
        self.assertLess(body.find("Purchase orders"), body.find("Margin"))
        self.assertLess(body.find("Margin"), body.find("Commission"))
        self.assertLess(body.find("Commission"), body.find("£600.00"))
        self.assertLess(body.find("£600.00"), body.find("£1,000.00"))

    def test_qualified_shows_earned_and_anomalies(self) -> None:
        rows = attach_commissions(
            [
                {
                    "date": dt.date(2026, 9, 4),
                    "label": "GR/1",
                    "sale": decimal.Decimal("32000"),
                    "po": decimal.Decimal("20000"),
                    "profit": decimal.Decimal("12000"),
                    "margin": decimal.Decimal("37.5"),
                }
            ]
        )
        anomalies = [
            {
                "date": dt.date(2026, 9, 5),
                "label": "GR/99",
                "sale": decimal.Decimal("400"),
                "po": decimal.Decimal("0"),
                "profit": decimal.Decimal("400"),
                "margin": decimal.Decimal("100"),
            }
        ]
        body = build_html("Sharon", "September 2026", rows, anomalies)
        self.assertIn("COMMISSION&nbsp;QUALIFIED", body)
        self.assertIn("Commission Earned:", body)
        self.assertIn("Anomalies", body)
        self.assertIn("GR/99", body)
        totals = month_totals(rows)
        self.assertEqual(totals["profit"], decimal.Decimal("12000"))

    def test_margin_colours(self) -> None:
        self.assertEqual(margin_colour(decimal.Decimal("19.9")), "#f4c7c3")
        self.assertEqual(margin_colour(decimal.Decimal("34.9")), "#ffe599")
        self.assertIsNone(margin_colour(decimal.Decimal("40")))
        self.assertEqual(margin_colour(decimal.Decimal("45.1")), "#b6d7a8")

    def test_current_calendar_month_helper(self) -> None:
        start, end = london_month_bounds(dt.date(2026, 9, 10))
        self.assertEqual(start, dt.date(2026, 9, 1))
        self.assertEqual(end, dt.date(2026, 9, 30))
        self.assertEqual(month_title(dt.date(2026, 9, 10)), "September 2026")


if __name__ == "__main__":
    unittest.main()
