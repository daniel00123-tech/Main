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
        jobs_by_ref: dict[str, dict[str, Any]] | None = None,
        verification_reference: str = "INV-200",
        verification_doc_id: str | None = None,
        verification_line_overrides: list[dict[str, Any]] | None = None,
    ) -> None:
        self.rows = rows
        self.docs_by_ref = docs_by_ref
        self.docs_by_id = docs_by_id
        self.verified_docs_by_id: dict[str, dict[str, Any]] = {}
        self.jobs_by_id = jobs_by_id
        self.jobs_by_ref = jobs_by_ref or {}
        self.verification_reference = verification_reference
        self.verification_doc_id = verification_doc_id
        self.verification_line_overrides = verification_line_overrides or []
        self.job_calls: list[dict[str, str | None]] = []
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
        self.job_calls.append({"job_id": job_id, "job_ref": job_ref})
        if job_id is not None:
            return self.jobs_by_id.get(job_id)
        if job_ref is not None:
            return self.jobs_by_ref.get(job_ref)
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
        verified_lines = []
        for index, line in enumerate(original["FinancialLines"]):
            verified_line = {**line, "NominalCode": self.added_lines[index]["NominalCode"]}
            if index < len(self.verification_line_overrides):
                verified_line.update(self.verification_line_overrides[index])
            verified_lines.append(verified_line)
        self.verified_docs_by_id[doc_id] = {
            **original,
            "DocId": self.verification_doc_id or doc_id,
            "Reference": self.verification_reference,
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

    def test_rejects_missing_purchase_and_order_document_types(self) -> None:
        for doc in (
            {},
            {"DocumentType": "Purchase Invoice"},
            {"DocumentType": "Purchase Order"},
            {"DocumentType": "Quote"},
        ):
            with self.subTest(doc=doc):
                processable, _reason = document_is_processable(doc)
                self.assertFalse(processable)

    def test_rejects_synchronised_documents(self) -> None:
        for doc in (
            {"DocumentType": "Invoice", "IsSynchronised": True},
            {"DocumentType": "Invoice", "SyncDate": "2026-05-21"},
        ):
            with self.subTest(doc=doc):
                processable, _reason = document_is_processable(doc)
                self.assertFalse(processable)


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

    def test_de_duplicates_invoices_without_sync_by_temp_reference(self) -> None:
        doc = {
            "DocId": "D1",
            "Reference": "TEMP-100",
            "DocumentType": "Invoice",
            "JobId": "J1",
            "FinancialLines": [{"UnitPrice": "1", "Quantity": "1", "NominalCode": "2002"}],
        }
        client = FakeBigChangeClient(
            rows=[
                {"InvoiceType": "SI", "Reference": "TEMP-100", "InvoiceId": "D1"},
                {"InvoiceType": "SI", "Reference": "TEMP-100", "InvoiceId": "D1-duplicate"},
            ],
            docs_by_ref={"TEMP-100": doc},
            docs_by_id={"D1": doc},
            jobs_by_id={"J1": {"JobId": "J1", "Type": "Fire", "Description": "Call Out"}},
        )

        report = TempInvoiceNominalCorrector(client).run()

        self.assertEqual(report.temp_invoices_scanned, 1)
        self.assertEqual(report.invoices_skipped, 1)

    def test_resolves_embedded_group_job_through_job_endpoint(self) -> None:
        doc = {
            "DocId": "D1",
            "Reference": "TEMP-100",
            "DocumentType": "Invoice",
            "Group": {"Jobs": [{"JobId": "J2", "Type": "Unknown", "Description": "Unknown"}]},
            "FinancialLines": [{"UnitPrice": "1", "Quantity": "1", "TaxRate": "20", "NominalCode": "9999"}],
        }
        client = FakeBigChangeClient(
            rows=[{"InvoiceType": "SI", "Reference": "TEMP-100", "InvoiceId": "D1"}],
            docs_by_ref={"TEMP-100": doc},
            docs_by_id={"D1": doc},
            jobs_by_id={"J2": {"JobId": "J2", "Type": "Fire", "Description": "Call Out"}},
        )

        report = TempInvoiceNominalCorrector(client).run()

        self.assertEqual(report.invoices_updated, 1)
        self.assertEqual(client.job_calls, [{"job_id": "J2", "job_ref": None}])
        self.assertEqual(client.added_lines[0]["JobId"], "J2")
        self.assertEqual(client.added_lines[0]["NominalCode"], "2002")

    def test_fails_when_verification_returns_a_different_doc_id(self) -> None:
        doc = {
            "DocId": "D1",
            "Reference": "TEMP-100",
            "DocumentType": "Invoice",
            "JobId": "J1",
            "FinancialLines": [{"UnitPrice": "1", "Quantity": "1", "TaxRate": "20", "NominalCode": "9999"}],
        }
        client = FakeBigChangeClient(
            rows=[{"InvoiceType": "SI", "Reference": "TEMP-100", "InvoiceId": "D1"}],
            docs_by_ref={"TEMP-100": doc},
            docs_by_id={"D1": doc},
            jobs_by_id={"J1": {"JobId": "J1", "Type": "Fire", "Description": "Call Out"}},
            verification_doc_id="D2",
        )

        report = TempInvoiceNominalCorrector(client).run()

        self.assertEqual(report.invoices_updated, 0)
        self.assertEqual(len(report.failures), 1)
        self.assertIn("DocId D2 instead of D1", report.failures[0]["reason"])

    def test_accepts_tax_code_normalisation_when_tax_rate_is_preserved(self) -> None:
        doc = {
            "DocId": "D1",
            "Reference": "TEMP-100",
            "DocumentType": "Invoice",
            "JobId": "J1",
            "FinancialLines": [
                {
                    "UnitPrice": "1",
                    "Quantity": "1",
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
            jobs_by_id={"J1": {"JobId": "J1", "Type": "Fire", "Description": "Call Out"}},
            verification_line_overrides=[{"TaxCode": "20.00", "TaxRate": "20.0"}],
        )

        report = TempInvoiceNominalCorrector(client).run()

        self.assertEqual(report.failures, [])
        self.assertEqual(report.invoices_updated, 1)


if __name__ == "__main__":
    unittest.main()
