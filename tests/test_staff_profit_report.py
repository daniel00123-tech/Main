import datetime as dt
import decimal
import unittest

from scripts.staff_commission import (
    attach_job_commissions,
    calculate_job_commission,
    sum_job_commissions,
)
from scripts.staff_profit_report import (
    DEFAULT_MAIL_CC,
    DEFAULT_MAIL_TO,
    RUN_EDGE,
    build_html,
    build_staff_rows,
    commission_style,
    daily_totals,
    graph_mail_payload,
    is_missing_po_anomaly,
    iter_display_rows,
)


D = decimal.Decimal


def _job(date, reference, sale, profit, cost=None, key=None):
    sale = D(str(sale))
    profit = D(str(profit))
    cost = D("0") if cost is None else D(str(cost))
    if cost == 0 and sale != profit:
        cost = sale - profit
    return {
        "key": key or reference,
        "date": date,
        "reference": reference,
        "sale": sale,
        "cost": cost,
        "profit": profit,
        "margin": (profit / sale * D("100")).quantize(D("0.1")) if sale else None,
    }


class DisplayRowTest(unittest.TestCase):
    def test_day_subtotal_sums_job_commission_and_does_not_recalculate(self) -> None:
        jobs = attach_job_commissions(
            [
                _job(dt.date(2026, 8, 3), "GR/1", "1500", "525"),
                _job(dt.date(2026, 8, 3), "GR/2", "1500", "525"),
                _job(dt.date(2026, 8, 4), "GR/3", "3000", "1050"),
            ]
        )
        display = iter_display_rows(jobs)
        kinds = [row["kind"] for row in display]
        self.assertEqual(kinds, ["job", "job", "day_total", "job", "day_total"])
        day1 = display[2]
        self.assertEqual(day1["commission"], D("52.50"))
        self.assertNotEqual(
            day1["commission"],
            calculate_job_commission(D("3000"), D("1050")).commission,
        )
        month_total = sum_job_commissions(jobs)
        self.assertEqual(month_total, D("131.25"))
        self.assertNotEqual(month_total, calculate_job_commission(D("6000"), D("2100")).commission)

    def test_daily_totals_use_summed_commission(self) -> None:
        jobs = attach_job_commissions(
            [
                _job(dt.date(2026, 8, 3), "GR/1", "1500", "525"),
                _job(dt.date(2026, 8, 3), "GR/2", "1500", "525"),
            ]
        )
        days = daily_totals(jobs)
        self.assertEqual(len(days), 1)
        self.assertEqual(days[0]["commission"], D("52.50"))


class HtmlReportTest(unittest.TestCase):
    def test_job_table_has_commission_columns_and_colours(self) -> None:
        jobs = attach_job_commissions(
            [
                _job(dt.date(2026, 8, 3), "GR/1", "1500", "525"),
                _job(dt.date(2026, 8, 4), "GR/2", "3000", "300"),
            ]
        )
        body = build_html(staff_name="Sharon", month_label="August 2026", job_rows=jobs, anomaly_rows=[])
        self.assertIn("commission report", body)
        self.assertIn(">Date</th>", body)
        self.assertIn("Group / job", body)
        self.assertIn("Commission", body)
        self.assertIn("Run profit", body)
        self.assertIn("Run comm.", body)
        self.assertIn("£26.25", body)
        self.assertIn("-£75.00", body)
        self.assertIn("NOT YET QUALIFIED", body)
        self.assertIn(commission_style(D("26.25")), body)
        self.assertIn(commission_style(D("-75.00")), body)
        self.assertIn(RUN_EDGE, body)
        self.assertNotIn("Day by day", body)
        self.assertNotIn("Your current commission is", body)
        self.assertNotIn("A group is included", body)
        self.assertNotIn("calculate_job_commission", body)
        status_at = body.find("STATUS:")
        table_at = body.find("Run profit")
        self.assertGreater(status_at, 0)
        self.assertGreater(table_at, status_at)

    def test_qualified_status_is_green_and_shows_earned(self) -> None:
        jobs = attach_job_commissions(
            [_job(dt.date(2026, 8, 1), "GR/BIG", "40000", "12000")]
        )
        body = build_html(staff_name="Sharon", month_label="August 2026", job_rows=jobs, anomaly_rows=[])
        self.assertIn("COMMISSION QUALIFIED", body)
        self.assertIn("Commission Earned:", body)
        self.assertIn("#d4edda", body)

    def test_duplicate_group_keys_are_not_created_by_row_builder(self) -> None:
        jobs = [
            {
                "id": 1,
                "categoryId": 132264,
                "jobGroupId": 10,
                "status": "completedOk",
                "reference": "EL1",
                "actualEndAt": "2026-08-01T12:00:00Z",
            },
            {
                "id": 2,
                "categoryId": 132264,
                "jobGroupId": 10,
                "status": "completedOk",
                "reference": "EL2",
                "actualEndAt": "2026-08-02T12:00:00Z",
            },
        ]
        docs = [
            {
                "OrderType": "Invoice",
                "JobId": "1",
                "DocumentDate": "2026-08-03",
                "lines": [{"LineQuantity": 1, "UnitPrice": "1500", "CostPrice": 0}],
            },
            {
                "OrderType": "Invoice",
                "JobId": "2",
                "DocumentDate": "2026-08-10",
                "lines": [{"LineQuantity": 1, "UnitPrice": "1500", "CostPrice": 0}],
            },
            {
                "OrderType": "PurchaseOrder",
                "JobId": "1",
                "DocumentDate": "2026-08-03",
                "lines": [{"LineQuantity": 1, "UnitPrice": "0", "CostPrice": "1950"}],
            },
        ]
        main_rows, anomaly_rows = build_staff_rows(
            jobs=jobs,
            docs=docs,
            group_refs={10: {"reference": "GR/10"}},
            category_id=132264,
            month_start=dt.date(2026, 8, 1),
            month_end=dt.date(2026, 8, 31),
        )
        self.assertEqual(anomaly_rows, [])
        self.assertEqual(len(main_rows), 1)
        self.assertEqual(main_rows[0]["reference"], "GR/10")
        self.assertEqual(main_rows[0]["sale"], D("3000.00"))
        self.assertEqual(main_rows[0]["cost"], D("1950.00"))
        self.assertEqual(main_rows[0]["profit"], D("1050.00"))
        attached = attach_job_commissions(main_rows)
        self.assertEqual(attached[0]["commission"], D("78.75"))


def _ok_job(
    job_id: int,
    group_id: int,
    category_id: int = 132264,
    reference: str = "",
    status: str = "completedOk",
    created_at: str = "2026-07-01T12:00:00Z",
) -> dict:
    return {
        "id": job_id,
        "categoryId": category_id,
        "jobGroupId": group_id,
        "status": status,
        "reference": reference or f"EL{job_id}",
        "createdAt": created_at,
        "actualEndAt": "2026-08-01T12:00:00Z",
    }


def _doc(order_type: str, job_id: int, date: str, amount: str, *, cost: bool = False) -> dict:
    line = {"LineQuantity": 1, "UnitPrice": "0", "CostPrice": amount} if cost else {
        "LineQuantity": 1,
        "UnitPrice": amount,
        "CostPrice": 0,
    }
    return {"OrderType": order_type, "JobId": str(job_id), "DocumentDate": date, "lines": [line]}


class MissingPurchaseOrderAnomalyTest(unittest.TestCase):
    def test_threshold_is_strictly_over_250_with_no_pound_po(self) -> None:
        self.assertFalse(is_missing_po_anomaly(D("250.00"), D("0")))
        self.assertTrue(is_missing_po_anomaly(D("250.01"), D("0")))
        self.assertFalse(is_missing_po_anomaly(D("2350"), D("1.00")))
        self.assertTrue(is_missing_po_anomaly(D("2350"), D("0.99")))

    def test_prior_month_po_is_included_when_the_last_job_is_invoiced_this_month(self) -> None:
        # GR/455 shape: July invoices/POs plus the final August invoice — one complete group.
        jobs = [_ok_job(1, 455, reference="EL1619"), _ok_job(2, 455, reference="EL1664")]
        docs = [
            _doc("PurchaseOrder", 1, "2026-07-13", "120", cost=True),
            _doc("Invoice", 1, "2026-07-17", "220"),
            _doc("PurchaseOrder", 2, "2026-07-17", "1600", cost=True),
            _doc("Invoice", 2, "2026-08-04", "2350"),
        ]
        main_rows, anomaly_rows = build_staff_rows(
            jobs=jobs,
            docs=docs,
            group_refs={455: {"reference": "GR/455"}},
            category_id=132264,
            month_start=dt.date(2026, 8, 1),
            month_end=dt.date(2026, 8, 31),
        )
        self.assertEqual(anomaly_rows, [])
        self.assertEqual(len(main_rows), 1)
        self.assertEqual(main_rows[0]["reference"], "GR/455")
        self.assertEqual(main_rows[0]["date"], dt.date(2026, 8, 4))
        self.assertEqual(main_rows[0]["sale"], D("2570.00"))
        self.assertEqual(main_rows[0]["cost"], D("1720.00"))
        self.assertEqual(main_rows[0]["profit"], D("850.00"))

    def test_mixed_group_follows_the_first_job_owner_not_the_named_category(self) -> None:
        # First job is Ella, so the whole group including Sharon's later invoice is Ella's.
        jobs = [
            _ok_job(10, 551, category_id=132225, reference="EL1767", created_at="2026-08-06T09:00:00Z"),
            _ok_job(11, 551, category_id=132264, reference="EL1769", created_at="2026-08-10T09:00:00Z"),
        ]
        docs = [
            _doc("PurchaseOrder", 10, "2026-08-06", "90", cost=True),
            _doc("Invoice", 10, "2026-08-07", "130"),
            _doc("Invoice", 11, "2026-08-10", "260"),
        ]
        sharon_main, sharon_anom = build_staff_rows(
            jobs=jobs,
            docs=docs,
            group_refs={551: {"reference": "GR/551"}},
            category_id=132264,
            month_start=dt.date(2026, 8, 1),
            month_end=dt.date(2026, 8, 31),
        )
        self.assertEqual(sharon_main, [])
        self.assertEqual(sharon_anom, [])

        ella_main, ella_anom = build_staff_rows(
            jobs=jobs,
            docs=docs,
            group_refs={551: {"reference": "GR/551"}},
            category_id=132225,
            month_start=dt.date(2026, 8, 1),
            month_end=dt.date(2026, 8, 31),
        )
        self.assertEqual(ella_anom, [])
        self.assertEqual(ella_main[0]["reference"], "GR/551")
        self.assertEqual(ella_main[0]["sale"], D("390.00"))
        self.assertEqual(ella_main[0]["cost"], D("90.00"))

    def test_sale_under_250_without_po_stays_on_the_running_table(self) -> None:
        jobs = [_ok_job(3, 409)]
        docs = [_doc("Invoice", 3, "2026-08-02", "120")]
        main_rows, anomaly_rows = build_staff_rows(
            jobs=jobs,
            docs=docs,
            group_refs={409: {"reference": "GR/409"}},
            category_id=132264,
            month_start=dt.date(2026, 8, 1),
            month_end=dt.date(2026, 8, 31),
        )
        self.assertEqual(anomaly_rows, [])
        self.assertEqual(main_rows[0]["sale"], D("120.00"))

    def test_po_of_one_pound_this_month_keeps_the_row_on_the_running_table(self) -> None:
        jobs = [_ok_job(4, 999)]
        docs = [
            _doc("Invoice", 4, "2026-08-12", "800"),
            _doc("PurchaseOrder", 4, "2026-08-12", "1", cost=True),
        ]
        main_rows, anomaly_rows = build_staff_rows(
            jobs=jobs,
            docs=docs,
            group_refs={999: {"reference": "GR/999"}},
            category_id=132264,
            month_start=dt.date(2026, 8, 1),
            month_end=dt.date(2026, 8, 31),
        )
        self.assertEqual(anomaly_rows, [])
        self.assertEqual(main_rows[0]["cost"], D("1.00"))

    def test_html_omits_anomalies_from_job_table_and_lists_them_below(self) -> None:
        jobs = attach_job_commissions(
            [_job(dt.date(2026, 8, 3), "GR/1", "1500", "525")]
        )
        anomalies = [
            {
                "date": dt.date(2026, 8, 4),
                "reference": "GR/455",
                "sale": D("2350.00"),
                "cost": D("0.00"),
                "profit": D("2350.00"),
                "margin": D("100.0"),
                "reason": "Sale over £250 with no purchase order",
            }
        ]
        body = build_html(
            staff_name="Sharon",
            month_label="August 2026",
            job_rows=jobs,
            anomaly_rows=anomalies,
        )
        job_start = body.find("Run profit")
        anomaly_start = body.find("Anomalies")
        self.assertGreater(anomaly_start, job_start)
        self.assertIn("GR/455", body[anomaly_start:])
        self.assertNotIn("GR/455", body[job_start:anomaly_start])
        self.assertNotIn("£2,350.00", body[job_start:anomaly_start])
        self.assertNotIn("Not included in the totals or commission above", body)


class CompleteGroupReportingTest(unittest.TestCase):
    def test_gr409_reports_full_july_and_august_totals_on_the_last_invoice_date(self) -> None:
        jobs = [
            _ok_job(192707210, 409, reference="EL1549"),
            _ok_job(193986828, 409, reference="EL1666"),
        ]
        docs = [
            _doc("PurchaseOrder", 192707210, "2026-07-03", "80", cost=True),
            _doc("Invoice", 192707210, "2026-07-07", "120"),
            _doc("PurchaseOrder", 193986828, "2026-07-20", "60", cost=True),
            _doc("Invoice", 193986828, "2026-08-02", "120"),
        ]
        august_main, august_anom = build_staff_rows(
            jobs=jobs,
            docs=docs,
            group_refs={409: {"reference": "GR/409"}},
            category_id=132264,
            month_start=dt.date(2026, 8, 1),
            month_end=dt.date(2026, 8, 31),
        )
        self.assertEqual(august_anom, [])
        self.assertEqual(len(august_main), 1)
        self.assertEqual(august_main[0]["reference"], "GR/409")
        self.assertEqual(august_main[0]["date"], dt.date(2026, 8, 2))
        self.assertEqual(august_main[0]["sale"], D("240.00"))
        self.assertEqual(august_main[0]["cost"], D("140.00"))
        self.assertEqual(august_main[0]["profit"], D("100.00"))

        july_main, july_anom = build_staff_rows(
            jobs=jobs,
            docs=docs,
            group_refs={409: {"reference": "GR/409"}},
            category_id=132264,
            month_start=dt.date(2026, 7, 1),
            month_end=dt.date(2026, 7, 31),
        )
        self.assertEqual(july_main, [])
        self.assertEqual(july_anom, [])

    def test_group_is_held_until_every_live_job_is_completed(self) -> None:
        """GR/482: a scheduled future job must keep the whole group off the report."""
        jobs = [
            _ok_job(1691, 482, reference="EL1691", status="completedOk"),
            _ok_job(1703, 482, reference="EL1703", status="completedWithIssues"),
            _ok_job(1801, 482, reference="EL1801", status="scheduled"),
        ]
        docs = [
            _doc("Invoice", 1691, "2026-07-22", "560"),
            _doc("PurchaseOrder", 1691, "2026-07-21", "350", cost=True),
            _doc("Invoice", 1703, "2026-08-10", "35"),
            _doc("PurchaseOrder", 1703, "2026-08-10", "455", cost=True),
        ]
        main_rows, anomaly_rows = build_staff_rows(
            jobs=jobs,
            docs=docs,
            group_refs={482: {"reference": "GR/482"}},
            category_id=132264,
            month_start=dt.date(2026, 8, 1),
            month_end=dt.date(2026, 8, 31),
        )
        self.assertEqual(main_rows, [])
        self.assertEqual(anomaly_rows, [])

    def test_po_only_group_is_not_reported_until_there_is_an_invoice(self) -> None:
        """GR/429 August: £664 of POs and no sale must not appear as a minus-profit row."""
        jobs = [
            _ok_job(1784, 429, reference="EL1784"),
            _ok_job(1977, 429, reference="EL1977"),
        ]
        docs = [
            _doc("PurchaseOrder", 1784, "2026-08-10", "664", cost=True),
        ]
        august_main, august_anom = build_staff_rows(
            jobs=jobs,
            docs=docs,
            group_refs={429: {"reference": "GR/429"}},
            category_id=132264,
            month_start=dt.date(2026, 8, 1),
            month_end=dt.date(2026, 8, 31),
        )
        self.assertEqual(august_main, [])
        self.assertEqual(august_anom, [])

    def test_last_invoice_month_includes_earlier_pos_even_if_one_job_was_never_invoiced(self) -> None:
        """GR/429: once the group is complete, September takes the full sale and PO history."""
        jobs = [
            _ok_job(1589, 429, reference="EL1589", created_at="2026-07-01T09:00:00Z"),
            _ok_job(1651, 429, reference="EL1651", created_at="2026-07-20T09:00:00Z"),
            _ok_job(1784, 429, reference="EL1784", created_at="2026-08-10T09:00:00Z"),
        ]
        docs = [
            _doc("Invoice", 1589, "2026-07-10", "120"),
            _doc("PurchaseOrder", 1589, "2026-07-10", "75", cost=True),
            _doc("Invoice", 1651, "2026-09-04", "680"),
            _doc("PurchaseOrder", 1651, "2026-07-20", "150", cost=True),
            _doc("PurchaseOrder", 1784, "2026-08-10", "664", cost=True),
        ]
        august_main, _ = build_staff_rows(
            jobs=jobs,
            docs=docs,
            group_refs={429: {"reference": "GR/429"}},
            category_id=132264,
            month_start=dt.date(2026, 8, 1),
            month_end=dt.date(2026, 8, 31),
        )
        self.assertEqual(august_main, [])

        september_main, september_anom = build_staff_rows(
            jobs=jobs,
            docs=docs,
            group_refs={429: {"reference": "GR/429"}},
            category_id=132264,
            month_start=dt.date(2026, 9, 1),
            month_end=dt.date(2026, 9, 30),
        )
        self.assertEqual(september_anom, [])
        self.assertEqual(len(september_main), 1)
        self.assertEqual(september_main[0]["date"], dt.date(2026, 9, 4))
        self.assertEqual(september_main[0]["sale"], D("800.00"))
        self.assertEqual(september_main[0]["cost"], D("889.00"))
        self.assertEqual(september_main[0]["profit"], D("-89.00"))
        attached = attach_job_commissions(september_main)
        self.assertEqual(attached[0]["commission"], D("-249.00"))

    def test_sharon_first_job_takes_ellas_later_po(self) -> None:
        jobs = [
            _ok_job(1, 88, category_id=132264, reference="EL1", created_at="2026-08-01T09:00:00Z"),
            _ok_job(2, 88, category_id=132225, reference="EL2", created_at="2026-08-08T09:00:00Z"),
        ]
        docs = [
            _doc("Invoice", 1, "2026-08-03", "500"),
            _doc("PurchaseOrder", 2, "2026-08-08", "200", cost=True),
        ]
        sharon_main, sharon_anom = build_staff_rows(
            jobs=jobs,
            docs=docs,
            group_refs={88: {"reference": "GR/88"}},
            category_id=132264,
            month_start=dt.date(2026, 8, 1),
            month_end=dt.date(2026, 8, 31),
        )
        self.assertEqual(sharon_anom, [])
        self.assertEqual(sharon_main[0]["sale"], D("500.00"))
        self.assertEqual(sharon_main[0]["cost"], D("200.00"))
        ella_main, ella_anom = build_staff_rows(
            jobs=jobs,
            docs=docs,
            group_refs={88: {"reference": "GR/88"}},
            category_id=132225,
            month_start=dt.date(2026, 8, 1),
            month_end=dt.date(2026, 8, 31),
        )
        self.assertEqual(ella_main, [])
        self.assertEqual(ella_anom, [])

    def test_documents_before_1_may_2026_are_ignored(self) -> None:
        jobs = [_ok_job(9, 12)]
        docs = [
            _doc("Invoice", 9, "2026-04-30", "500"),
            _doc("PurchaseOrder", 9, "2026-04-30", "200", cost=True),
            _doc("Invoice", 9, "2026-08-10", "120"),
        ]
        main_rows, anomaly_rows = build_staff_rows(
            jobs=jobs,
            docs=docs,
            group_refs={12: {"reference": "GR/12"}},
            category_id=132264,
            month_start=dt.date(2026, 8, 1),
            month_end=dt.date(2026, 8, 31),
        )
        self.assertEqual(anomaly_rows, [])
        self.assertEqual(main_rows[0]["sale"], D("120.00"))
        self.assertEqual(main_rows[0]["cost"], D("0.00"))


class LaurenReportWiringTest(unittest.TestCase):
    def test_lauren_html_uses_stepped_minus_not_uk_catchup(self) -> None:
        jobs = attach_job_commissions(
            [_job(dt.date(2026, 9, 4), "GR/1", "705", "106", cost="599")],
            profile="lauren",
        )
        self.assertEqual(jobs[0]["commission"], D("-5.00"))
        body = build_html(
            staff_name="Lauren",
            month_label="September 2026",
            job_rows=jobs,
            anomaly_rows=[],
        )
        self.assertIn("Lauren — September 2026 commission report", body)
        self.assertIn("-£5.00", body)
        self.assertNotIn("-£35.00", body)

    def test_email_always_has_to_and_cc_william(self) -> None:
        payload = graph_mail_payload(
            "Lauren — September 2026 — commission report",
            "<p>x</p>",
            DEFAULT_MAIL_TO,
            DEFAULT_MAIL_CC,
        )
        self.assertEqual(
            payload["message"]["toRecipients"][0]["emailAddress"]["address"],
            "william@elvexpropertyservices.com",
        )
        self.assertEqual(
            payload["message"]["ccRecipients"][0]["emailAddress"]["address"],
            "william@elvexpropertyservices.com",
        )
        self.assertTrue(payload["saveToSentItems"])


if __name__ == "__main__":
    unittest.main()
