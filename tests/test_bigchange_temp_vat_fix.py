import importlib.util
from pathlib import Path
import sys
import unittest


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "bigchange_temp_vat_fix.py"
SPEC = importlib.util.spec_from_file_location("bigchange_temp_vat_fix", MODULE_PATH)
fix = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = fix
SPEC.loader.exec_module(fix)


class AuthModeTests(unittest.TestCase):
    def test_api_key_mode_only_requires_and_sends_key_header(self):
        self.assertEqual(
            fix.required_env_missing(
                {
                    "BIGCHANGE_AUTH_MODE": "api_key",
                    "BIGCHANGE_API_KEY": "test-key",
                }
            ),
            [],
        )

        client = fix.BigChangeClient(
            base_url="https://example.invalid",
            api_key="test-key",
            username="user@example.invalid",
            password="password",
            auth_mode="api_key",
            timeout=1,
        )

        self.assertEqual(client._headers()["key"], "test-key")
        self.assertNotIn("Authorization", client._headers())

    def test_default_combined_auth_preserves_existing_credentials_contract(self):
        self.assertEqual(
            fix.required_env_missing({"BIGCHANGE_API_KEY": "test-key"}),
            ["BIGCHANGE_USERNAME", "BIGCHANGE_PASSWORD"],
        )

        client = fix.BigChangeClient(
            base_url="https://example.invalid",
            api_key="test-key",
            username="user@example.invalid",
            password="password",
            auth_mode="api_key_basic",
            timeout=1,
        )

        headers = client._headers()
        self.assertEqual(headers["key"], "test-key")
        self.assertIn("Authorization", headers)


class InvoiceFilteringTests(unittest.TestCase):
    def test_groups_only_temp_sales_invoices_by_reference_and_invoice_id(self):
        grouped = fix.group_temp_sales_invoices(
            [
                {"InvoiceType": "SI", "Reference": "TEMP-1", "InvoiceId": "doc-1"},
                {"InvoiceType": "SI", "Reference": "TEMP-1", "InvoiceId": "doc-1"},
                {"InvoiceType": "SI", "Reference": "TEMP-2", "FinancialDocId": "doc-2"},
                {"InvoiceType": "SI", "Reference": "INV-1", "InvoiceId": "doc-3"},
                {"InvoiceType": "CN", "Reference": "TEMP-CN", "InvoiceId": "doc-4"},
            ]
        )

        self.assertEqual(list(grouped), ["TEMP-1|doc-1", "TEMP-2|doc-2"])


class ProcessInvoiceTests(unittest.TestCase):
    def test_replaces_bad_tax_line_and_regenerates_existing_doc(self):
        original_doc = {
            "DocId": "doc-1",
            "JobId": "job-1",
            "Reference": "TEMP-123",
            "FinancialLine": [
                {
                    "InvoiceItemId": "keep-1",
                    "Description": "Accepted line",
                    "UnitPrice": "10.00",
                    "Quantity": "2",
                    "ItemCost": "1.25",
                    "Currency": "GBP",
                    "NominalCode": "4000",
                    "TaxCode": "20% (VAT on Income)",
                },
                {
                    "InvoiceItemId": "old-2",
                    "Description": "Needs VAT fix",
                    "UnitPrice": "25.50",
                    "Quantity": "3",
                    "ItemCost": "4.75",
                    "Currency": "EUR",
                    "NominalAccountCode": "4010",
                    "TaxCode": "No VAT",
                },
            ],
        }
        verified_doc = {
            **original_doc,
            "FinancialLine": [
                original_doc["FinancialLine"][0],
                {
                    **original_doc["FinancialLine"][1],
                    "InvoiceItemId": "new-2",
                    "TaxCode": "Domestic Reverse Charge @ 20% (VAT on Income)",
                },
            ],
        }
        client = FakeClient(original_doc, verified_doc)

        outcome = fix.process_invoice(client, "TEMP-123", "doc-1", pause_seconds=0)

        self.assertEqual(outcome, {"skipped": False, "lines_corrected": 1, "converted_temp_to_inv": False})
        self.assertEqual(
            client.generate_params,
            {
                "JobId": "job-1",
                "financialDocType": "Invoice",
                "DocId": "doc-1",
                "lineItemIds": "keep-1,new-2",
            },
        )
        self.assertEqual(client.created_item_params["Reference"], "AI-TEMP-123-VATFIX-2")
        self.assertEqual(client.created_item_params["Description"], "Needs VAT fix")
        self.assertEqual(client.created_item_params["UnitPrice"], "25.5")
        self.assertEqual(client.created_item_params["DefaultCurrency"], "EUR")
        self.assertEqual(client.created_item_params["DefaultCost"], "4.75")
        self.assertEqual(client.created_item_params["NominalCode"], "4010")
        self.assertEqual(client.added_line_params["Quantity"], "3")
        self.assertEqual(client.added_line_params["UnitPrice"], "25.5")
        self.assertEqual(client.added_line_params["NominalCode"], "4010")


class FakeClient:
    def __init__(self, original_doc, verified_doc):
        self.original_doc = original_doc
        self.verified_doc = verified_doc
        self.financial_doc_reads = 0
        self.created_item_params = None
        self.added_line_params = None
        self.generate_params = None

    def call(self, action, params=None):
        if action == "FinancialDoc":
            self.financial_doc_reads += 1
            return self.original_doc if self.financial_doc_reads == 1 else self.verified_doc
        if action == "JobFinancialLines":
            return []
        if action == "CreatePredefinedInvItem":
            self.created_item_params = params
            return {"PredefinedInvItemId": "predefined-2"}
        if action == "AddJobFinancialLine":
            self.added_line_params = params
            return {"invoiceItemId": "new-2"}
        if action == "GenerateFinancialDocForJob":
            self.generate_params = params
            return {"DocId": "doc-1"}
        raise AssertionError(f"unexpected action {action}")


if __name__ == "__main__":
    unittest.main()
