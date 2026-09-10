import datetime as dt
import decimal
import unittest

from scripts.elvex_daily_group_profit import build_html, margin_colour, margin_pct


class HtmlBodyTest(unittest.TestCase):
    def test_email_starts_with_table_and_omits_method_notes(self) -> None:
        yesterday = dt.date(2026, 9, 9)
        rows = [
            {
                "ref": "GR/655",
                "sale": decimal.Decimal("865.00"),
                "po": decimal.Decimal("490.00"),
                "profit": decimal.Decimal("375.00"),
                "margin": decimal.Decimal("43.4"),
            }
        ]
        body = build_html(yesterday, rows)
        stripped = body[body.find("<body") :]
        self.assertIn("<table", stripped)
        self.assertLess(stripped.find("<table"), stripped.find("GR/655"))
        self.assertNotIn("JobWatch", body)
        self.assertNotIn("Notes:", body)
        self.assertNotIn("is not GR/", body)
        self.assertNotIn("Job 190", body)
        self.assertNotIn("CENTRUS", body)
        self.assertIn("Group reference number", body)
        self.assertIn("Summary", body)

    def test_empty_day_uses_table_message(self) -> None:
        body = build_html(dt.date(2026, 9, 9), [])
        self.assertIn("No GR/ groups invoiced yesterday.", body)
        self.assertNotIn("JobWatch", body)

    def test_margin_colours(self) -> None:
        self.assertEqual(margin_colour(decimal.Decimal("-421.1")), "#f4c7c3")
        self.assertEqual(margin_colour(decimal.Decimal("31.2")), "#ffe599")
        self.assertEqual(margin_colour(decimal.Decimal("43.4")), None)
        self.assertEqual(margin_colour(decimal.Decimal("74.3")), "#b6d7a8")
        self.assertIsNone(margin_colour(None))
        self.assertIsNone(margin_pct(decimal.Decimal("0"), decimal.Decimal("0")))


if __name__ == "__main__":
    unittest.main()
