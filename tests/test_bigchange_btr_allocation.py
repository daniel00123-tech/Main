import unittest

from scripts.bigchange_btr_allocation import parse_duration


class DurationParsingTest(unittest.TestCase):
    def test_parses_hms_duration(self) -> None:
        self.assertEqual(parse_duration("01:30:00"), 90)
        self.assertEqual(parse_duration("00:00:30"), 1)

    def test_parses_numeric_minute_duration(self) -> None:
        self.assertEqual(parse_duration("60"), 60)
        self.assertEqual(parse_duration(120), 120)

    def test_ignores_empty_or_non_positive_duration(self) -> None:
        self.assertIsNone(parse_duration(""))
        self.assertIsNone(parse_duration("0"))


if __name__ == "__main__":
    unittest.main()
