import unittest
from typing import Any

from scripts.bigchange_temp_invoice_nominals import (
    TempInvoiceNominalCorrector,
    classify_nominal_code,
    document_is_processable,
    is_target_invoice_row,
)


class FakeBigChangeClient:
    def __init__(
        self,
        rows: list[dict[str, Any]],
        docs_by_ref: dict[str, dict[str, Any] | None],
        docs_by_id: dict[str, dict[str, Any]],
        jobs_by_id: dict[str, dict[str, Any]],
        tax_code_after_generate: str | None = None,
    ) -> None:
        self.rows = rows
        self.docs_by_ref = docs_by_ref
        self.docs_by_id = docs_by_id
        self.verified_docs_by_id: dict[str, dict[str, Any]] = {}
        self.jobs_by_id = jobs_by_id
        self.tax_code_after_generate = tax_code_after_generate
        self.created_items: list[dict[str, Any]] = []
        self.added_lines: list[dict[str, Any]] = []
        self.generated_docs: list[dict[str, Any]] = []

    def invoices_without_sync(self) -> list[dict[str, Any]]:
        return self.rows

    def financial_doc(self, *, doc_ref: str | None = None, doc_id: str | None = None) -> dict[str, Any] | None:
        if doc_ref is not None:
            return self.docs_by_ref.get(doc_ref)
        if doc_id is not None:
            return self.verified_docs_by_id.get(doc_id) or self.docs_by_id.get(doc_id)
        return None

    def job(self, *, job_id: str | None = None, job_ref: str | None = None) -> dict[str, Any] | None:
        if job_id is not None:
            return self.jobs_by_id.get(job_id)
        return None

    def group_jobs(self, group_id: str) -> list[dict[str, Any]]:
        return []

    def create_predefined_inv_item(self, params: dict[str, Any]) -> str:
        self.created_items.append(params)
        return f"item-{len(self.created_items)}"

    def add_job_financial_line(self, params: dict[str, Any]) -> str:
        self.added_lines.append(params)
        return f"line-{len(self.added_lines)}"

    def generate_financial_doc_for_job(self, params: dict[str, Any]) -> dict[str, Any]:
        self.generated_docs.append(params)
        doc_id = str(params["DocId"])
        original = self.docs_by_id[doc_id]
        verified_lines = [
            {**line, "NominalCode": self.added_lines[index]["NominalCode"]}
            for index, line in enumerate(original["FinancialLines"])
        ]
        if self.tax_code_after_generate is not None:
            verified_lines = [{**line, "TaxCode": self.tax_code_after_generate} for line in verified_lines]
        self.verified_docs_by_id[doc_id] = {
            **original,
            "Reference": "INV-200",
            "FinancialLines": verified_lines,
        }
        return {"Code": 0, "Result": {"DocId": doc_id}}


class ClassificationTest(unittest.TestCase):
    def test_fire_safety_maps_to_fire_codes_by_work_type(self) -> None:
        cases = (
            ({"Type": "Fire Alarm", "Description": "Call Out fault"}, "2002"),
            ({"Type": "Fire", "Description": "PPM service"}, "2102"),
            ({"Type": "Fire", "Description": "Install works"}, "2202"),
        )

        for job, expected in cases:
            with self.subTest(job=job):
                self.assertEqual(classify_nominal_code(job), expected)

    def test_falls_back_to_grounds_project_when_unsure(self) -> None:
        self.assertEqual(classify_nominal_code({"Type": "Unknown", "Description": "Other"}), "2205")

    def test_maps_non_fire_disciplines(self) -> None:
        self.assertEqual(classify_nominal_code({"Type": "Gas", "Description": "repair leak"}), "2001")
        self.assertEqual(classify_nominal_code({"Type": "Cleaning", "Description": "Scheduled PPM"}), "2104")
        self.assertEqual(classify_nominal_code({"Type": "Roof", "Description": "Refurbishment works"}), "2203")


class SafetyFilterTest(unittest.TestCase):
    def test_only_targets_temp_sales_invoices(self) -> None:
        self.assertTrue(is_target_invoice_row({"InvoiceType": "SI", "Reference": "TEMP-123"}))
        self.assertFalse(is_target_invoice_row({"InvoiceType": "SI", "Reference": "INV-123"}))
        self.assertFalse(is_target_invoice_row({"InvoiceType": "CN", "Reference": "TEMP-123"}))
        self.assertFalse(is_target_invoice_row({"InvoiceType": "PO", "Reference": "TEMP-123"}))

    def test_rejects_cancelled_deleted_or_rejected_documents(self) -> None:
        for field in ("CancellationDate", "DeletionDate", "RejectionDate"):
            with self.subTest(field=field):
                processable, reason = document_is_processable({"DocumentType": "Invoice", field: "2026-05-19"})
                self.assertFalse(processable)
                self.assertIn(field, reason)

    def test_rejects_non_invoice_document_types(self) -> None:
        processable, reason = document_is_processable({"DocumentType": "Credit Note"})

        self.assertFalse(processable)
        self.assertIn("Credit Note", reason)

        processable, reason = document_is_processable({"DocumentType": "Purchase Invoice"})

        self.assertFalse(processable)
        self.assertIn("Purchase Invoice", reason)


class TempInvoiceNominalCorrectorTest(unittest.TestCase):
    def test_rebuilds_existing_invoice_with_replacement_nominal_lines(self) -> None:
        doc = {
            "DocId": "D1",
            "Reference": "TEMP-100",
            "DocumentType": "Invoice",
            "JobId": "J1",
            "FinancialLines": [
                {
                    "Description": "Fire alarm call out",
                    "UnitPrice": "125.00",
                    "Quantity": "2",
                    "ItemCost": "40",
                    "Currency": "GBP",
                    "TaxCode": "T1",
                    "TaxRate": "20",
                    "NominalCode": "9999",
                },
                {
                    "Description": "Second line",
                    "UnitPrice": "10",
                    "Quantity": "1",
                    "ItemCost": "0",
                    "Currency": "GBP",
                    "TaxCode": "T1",
                    "TaxRate": "20",
                    "NominalCode": "2002",
                },
            ],
        }
        client = FakeBigChangeClient(
            rows=[
                {"InvoiceType": "SI", "Reference": "TEMP-100", "InvoiceId": ""},
                {"InvoiceType": "SI", "Reference": "TEMP-100", "InvoiceId": "D1"},
                {"InvoiceType": "SI", "Reference": "INV-999", "InvoiceId": "D2"},
                {"InvoiceType": "CN", "Reference": "TEMP-CN", "InvoiceId": "D3"},
            ],
            docs_by_ref={"TEMP-100": doc},
            docs_by_id={"D1": doc},
            jobs_by_id={"J1": {"JobId": "J1", "Type": "Fire Alarm", "Description": "Call Out fault"}},
        )

        report = TempInvoiceNominalCorrector(client).run()

        self.assertEqual(report.temp_invoices_scanned, 1)
        self.assertEqual(report.invoices_updated, 1)
        self.assertEqual(report.invoices_skipped, 0)
        self.assertEqual(report.lines_updated, 1)
        self.assertEqual(report.invoices_where_temp_became_inv, [{"from": "TEMP-100", "to": "INV-200"}])
        self.assertEqual(report.failures, [])
        self.assertEqual(len(client.created_items), 2)
        self.assertEqual(client.created_items[0]["Reference"], "AI-TEMP-100-NOMINAL-2002-1")
        self.assertEqual(client.created_items[0]["Description"], "Fire alarm call out")
        self.assertEqual(client.created_items[0]["UnitPrice"], "125.00")
        self.assertEqual(client.created_items[0]["Vat"], "T1")
        self.assertEqual(client.created_items[0]["DefaultCost"], "40")
        self.assertEqual(client.created_items[0]["DefaultVat"], "20")
        self.assertEqual(client.created_items[0]["NominalCode"], "2002")
        self.assertEqual(client.added_lines[0]["JobId"], "J1")
        self.assertEqual(client.added_lines[0]["PredefinedItemId"], "item-1")
        self.assertEqual(client.added_lines[0]["ItemType"], "predefined")
        self.assertEqual(client.added_lines[0]["Quantity"], "2")
        self.assertEqual(client.added_lines[0]["NominalCode"], "2002")
        self.assertEqual(
            client.generated_docs,
            [
                {
                    "JobId": "J1",
                    "financialDocType": "Invoice",
                    "DocId": "D1",
                    "lineItemIds": "line-1,line-2",
                }
            ],
        )

    def test_skips_invoice_when_all_lines_already_have_expected_nominal(self) -> None:
        doc = {
            "DocId": "D1",
            "Reference": "TEMP-100",
            "DocumentType": "Invoice",
            "JobId": "J1",
            "FinancialLines": [
                {
                    "Description": "Electrical PPM",
                    "UnitPrice": "100",
                    "Quantity": "1",
                    "TaxCode": "T1",
                    "TaxRate": "20",
                    "NominalCode": "2101",
                }
            ],
        }
        client = FakeBigChangeClient(
            rows=[{"InvoiceType": "SI", "Reference": "TEMP-100", "InvoiceId": "D1"}],
            docs_by_ref={"TEMP-100": doc},
            docs_by_id={"D1": doc},
            jobs_by_id={"J1": {"JobId": "J1", "Type": "Electrical", "Description": "PPM service"}},
        )

        report = TempInvoiceNominalCorrector(client).run()

        self.assertEqual(report.temp_invoices_scanned, 1)
        self.assertEqual(report.invoices_updated, 0)
        self.assertEqual(report.invoices_skipped, 1)
        self.assertEqual(client.created_items, [])
        self.assertEqual(client.added_lines, [])
        self.assertEqual(client.generated_docs, [])

    def test_skips_if_full_document_reference_is_not_temp(self) -> None:
        doc = {
            "DocId": "D1",
            "Reference": "INV-100",
            "DocumentType": "Invoice",
            "JobId": "J1",
            "FinancialLines": [{"UnitPrice": "1", "Quantity": "1", "NominalCode": "9999"}],
        }
        client = FakeBigChangeClient(
            rows=[{"InvoiceType": "SI", "Reference": "TEMP-100", "InvoiceId": "D1"}],
            docs_by_ref={"TEMP-100": doc},
            docs_by_id={"D1": doc},
            jobs_by_id={"J1": {"JobId": "J1", "Type": "Fire", "Description": "Call Out"}},
        )

        report = TempInvoiceNominalCorrector(client).run()

        self.assertEqual(report.invoices_skipped, 1)
        self.assertEqual(client.generated_docs, [])

    def test_accepts_tax_code_normalization_when_tax_rate_is_preserved(self) -> None:
        doc = {
            "DocId": "D1",
            "Reference": "TEMP-100",
            "DocumentType": "Invoice",
            "JobId": "J1",
            "FinancialLines": [
                {
                    "Description": "Fire alarm call out",
                    "UnitPrice": "125.00",
                    "Quantity": "2",
                    "TaxCode": "T1",
                    "TaxRate": "20",
                    "NominalCode": "9999",
                }
            ],
        }
        client = FakeBigChangeClient(
            rows=[{"InvoiceType": "SI", "Reference": "TEMP-100", "InvoiceId": "D1"}],
            docs_by_ref={"TEMP-100": doc},
            docs_by_id={"D1": doc},
            jobs_by_id={"J1": {"JobId": "J1", "Type": "Fire Alarm", "Description": "Call Out fault"}},
            tax_code_after_generate="VAT20",
        )

        report = TempInvoiceNominalCorrector(client).run()

        self.assertEqual(report.invoices_updated, 1)
        self.assertEqual(report.failures, [])


if __name__ == "__main__":
    unittest.main()
