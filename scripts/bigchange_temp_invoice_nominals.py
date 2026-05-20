#!/usr/bin/env python3
"""Correct nominal codes on unsynchronised TEMP BigChange sales invoices."""

from __future__ import annotations

import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any, Protocol


DEFAULT_CURRENCY = "GBP"
FALLBACK_NOMINAL_CODE = "2205"

DISCIPLINE_CODES = {
    ("mechanical", "reactive"): "2001",
    ("fire", "reactive"): "2002",
    ("fabric", "reactive"): "2003",
    ("cleaning", "reactive"): "2004",
    ("grounds", "reactive"): "2005",
    ("mechanical", "contract"): "2101",
    ("fire", "contract"): "2102",
    ("fabric", "contract"): "2103",
    ("cleaning", "contract"): "2104",
    ("grounds", "contract"): "2105",
    ("mechanical", "project"): "2201",
    ("fire", "project"): "2202",
    ("fabric", "project"): "2203",
    ("cleaning", "project"): "2204",
    ("grounds", "project"): "2205",
}

DISCIPLINE_KEYWORDS = {
    "fire": ("fire", "fire alarm", "emergency lighting"),
    "mechanical": (
        "gas",
        "electrical",
        "plumbing",
        "hvac",
        "air conditioning",
        "boiler",
        "cylinder",
        "heating",
        "radiator",
        "drainage",
        "water",
        "mechanical",
    ),
    "fabric": (
        "building",
        "fabric",
        "door",
        "window",
        "lock",
        "roof",
        "flooring",
        "carpentry",
        "decorating",
        "painting",
        "pest",
        "damp",
        "mould",
        "plaster",
    ),
    "cleaning": ("cleaning", "clean", "clearance"),
    "grounds": ("grounds", "garden", "gardening", "landscaping", "external grounds"),
}

WORK_TYPE_KEYWORDS = {
    "reactive": (
        "call out",
        "reactive",
        "remedial",
        "repair",
        "fit parts",
        "emergency",
        "ooh",
        "fault",
        "leak",
        "no access",
    ),
    "contract": ("ppm", "service", "maintenance", "contract", "scheduled"),
    "project": (
        "project",
        "works",
        "installation",
        "install",
        "estimate",
        "quote",
        "upgrade",
        "refurbishment",
    ),
}


class ConfigError(RuntimeError):
    pass


def required_env(name: str) -> str:
    value = os.environ.get(name)
    if value is None or value == "":
        raise ConfigError(f"Missing required environment variable: {name}")
    return value


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def normalized_text(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", clean_text(value).lower()).strip()


def compact_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def contains_keyword(text: str, keyword: str) -> bool:
    norm = f" {normalized_text(text)} "
    phrase = f" {normalized_text(keyword)} "
    return phrase in norm


def first_present(row: dict[str, Any], names: tuple[str, ...]) -> Any:
    compacted = {compact_key(key): value for key, value in row.items()}
    for name in names:
        key = compact_key(name)
        if key in compacted and compacted[key] not in (None, ""):
            return compacted[key]
    return None


def is_populated(value: Any) -> bool:
    text = clean_text(value)
    if not text:
        return False
    return text.lower() not in {"none", "null", "0", "0001-01-01", "0001-01-01 00:00:00"}


def as_decimal(value: Any, default: str = "0") -> Decimal:
    if value in (None, ""):
        return Decimal(default)
    try:
        return Decimal(str(value).replace(",", "").strip())
    except (InvalidOperation, ValueError):
        return Decimal(default)


def decimal_equal(left: Any, right: Any) -> bool:
    return as_decimal(left) == as_decimal(right)


def code_is_success(payload: dict[str, Any]) -> bool:
    code = payload.get("Code")
    return code in (None, "", 0, "0")


def nested_rows(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [row for row in value if isinstance(row, dict)]
    if isinstance(value, dict):
        rows: list[dict[str, Any]] = []
        for nested in value.values():
            if isinstance(nested, list):
                rows.extend(row for row in nested if isinstance(row, dict))
        if rows:
            return rows
        return [value]
    return []


def find_identifier(value: Any, candidates: tuple[str, ...]) -> str | None:
    if isinstance(value, dict):
        direct = first_present(value, candidates)
        if direct not in (None, ""):
            return clean_text(direct)
        for nested in value.values():
            found = find_identifier(nested, candidates)
            if found:
                return found
    elif isinstance(value, list):
        for item in value:
            found = find_identifier(item, candidates)
            if found:
                return found
    return None


def result_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    result = payload.get("Result")
    rows = nested_rows(result)
    if rows:
        return rows
    return nested_rows(payload)


def result_document(payload: dict[str, Any]) -> dict[str, Any] | None:
    result = payload.get("Result")
    if isinstance(result, dict):
        for key in ("FinancialDoc", "Document", "Doc"):
            nested = result.get(key)
            if isinstance(nested, dict):
                return nested
        if looks_like_financial_doc(result):
            return result
        for nested in result.values():
            if isinstance(nested, dict) and looks_like_financial_doc(nested):
                return nested
    elif isinstance(result, list):
        for row in result:
            if isinstance(row, dict) and looks_like_financial_doc(row):
                return row
    if looks_like_financial_doc(payload):
        return payload
    rows = result_rows(payload)
    return rows[0] if rows else None


def looks_like_financial_doc(row: dict[str, Any]) -> bool:
    return any(
        first_present(row, names) not in (None, "")
        for names in (
            ("DocId", "FinancialDocId", "InvoiceId"),
            ("DocumentType", "DocType"),
            ("FinancialLines", "FinancialLine", "InvoiceLines", "Lines", "LineItems"),
        )
    )


def looks_like_financial_line(row: dict[str, Any]) -> bool:
    return any(
        first_present(row, names) not in (None, "")
        for names in (
            ("LineId", "FinancialLineId", "LineItemId"),
            ("UnitPrice", "Price", "NetPrice", "UnitNetPrice"),
            ("Quantity", "Qty"),
            ("NominalCode", "JWNominalCode"),
            ("Description", "ItemDescription", "Name"),
        )
    )


def line_rows(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [row for row in value if isinstance(row, dict)]
    if isinstance(value, dict):
        if looks_like_financial_line(value):
            return [value]
        rows: list[dict[str, Any]] = []
        for nested in value.values():
            if isinstance(nested, list):
                rows.extend(row for row in nested if isinstance(row, dict))
            elif isinstance(nested, dict):
                rows.extend(line_rows(nested))
        if rows:
            return rows
    return []


def extract_lines(doc: dict[str, Any]) -> list[dict[str, Any]]:
    line_keys = {
        "financiallines",
        "financialline",
        "financialdoclines",
        "financialdocline",
        "invoicelines",
        "invoiceline",
        "lines",
        "lineitems",
        "items",
    }
    for key, value in doc.items():
        if compact_key(key) in line_keys:
            rows = line_rows(value)
            if rows:
                return rows
    for value in doc.values():
        if isinstance(value, dict):
            rows = extract_lines(value)
            if rows:
                return rows
    return []


class BigChangeApi(Protocol):
    def invoices_without_sync(self) -> list[dict[str, Any]]:
        ...

    def financial_doc(self, *, doc_ref: str | None = None, doc_id: str | None = None) -> dict[str, Any] | None:
        ...

    def job(self, *, job_id: str | None = None, job_ref: str | None = None) -> dict[str, Any] | None:
        ...

    def group_jobs(self, group_id: str) -> list[dict[str, Any]]:
        ...

    def create_predefined_inv_item(self, params: dict[str, Any]) -> str:
        ...

    def add_job_financial_line(self, params: dict[str, Any]) -> str:
        ...

    def generate_financial_doc_for_job(self, params: dict[str, Any]) -> dict[str, Any]:
        ...


class BigChangeClient:
    def __init__(self) -> None:
        self.base_url = required_env("BIGCHANGE_BASE_URL")
        username = required_env("BIGCHANGE_USERNAME")
        password = required_env("BIGCHANGE_PASSWORD")
        api_key = required_env("BIGCHANGE_API_KEY")
        token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
        self.headers = {
            "Authorization": f"Basic {token}",
            "key": api_key,
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

    def get(
        self,
        action: str,
        params: dict[str, Any] | None = None,
        timeout: int = 60,
        attempts: int = 3,
    ) -> dict[str, Any]:
        query = {"action": action}
        if params:
            query.update({k: v for k, v in params.items() if v is not None and v != ""})
        url = f"{self.base_url}?{urllib.parse.urlencode(query)}"
        req = urllib.request.Request(url, headers=self.headers)
        last_error: Exception | None = None
        for attempt in range(attempts):
            try:
                with urllib.request.urlopen(req, timeout=timeout) as response:
                    raw = response.read()
                payload = json.loads(raw.decode("utf-8-sig"))
                if not isinstance(payload, dict):
                    raise RuntimeError(f"Unexpected response for {action}")
                return payload
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
                last_error = exc
                if attempt == attempts - 1:
                    break
                time.sleep(2**attempt)
        raise RuntimeError(f"BigChange request failed for {action}: {type(last_error).__name__}")

    def invoices_without_sync(self) -> list[dict[str, Any]]:
        payload = self.get("InvoicesWithoutSync")
        if not code_is_success(payload):
            raise RuntimeError("InvoicesWithoutSync returned an error")
        return result_rows(payload)

    def financial_doc(self, *, doc_ref: str | None = None, doc_id: str | None = None) -> dict[str, Any] | None:
        params = {"IncludeAllDocTypes": "true"}
        if doc_ref:
            params["docRef"] = doc_ref
        if doc_id:
            params["docId"] = doc_id
        payload = self.get("FinancialDoc", params)
        if not code_is_success(payload):
            return None
        return result_document(payload)

    def job(self, *, job_id: str | None = None, job_ref: str | None = None) -> dict[str, Any] | None:
        params: dict[str, Any]
        if job_id:
            params = {"JobId": job_id}
        elif job_ref:
            params = {"JobRef": job_ref}
        else:
            return None
        payload = self.get("Job", params)
        if not code_is_success(payload):
            return None
        rows = result_rows(payload)
        return rows[0] if rows else result_document(payload)

    def group_jobs(self, group_id: str) -> list[dict[str, Any]]:
        for action in ("JobGroup", "JobGroupJobs"):
            payload = self.get(action, {"GroupId": group_id}, attempts=2)
            if code_is_success(payload):
                rows = result_rows(payload)
                jobs = [row for row in rows if first_present(row, ("JobId", "JobReference", "JobRef"))]
                if jobs:
                    return jobs
        return []

    def create_predefined_inv_item(self, params: dict[str, Any]) -> str:
        payload = self.get("CreatePredefinedInvItem", params)
        if not code_is_success(payload):
            raise RuntimeError("CreatePredefinedInvItem returned an error")
        item_id = find_identifier(payload, ("PredefinedItemId", "PredefinedInvItemId", "ItemId", "Id", "ID"))
        if not item_id:
            raise RuntimeError("CreatePredefinedInvItem did not return an item id")
        return item_id

    def add_job_financial_line(self, params: dict[str, Any]) -> str:
        payload = self.get("AddJobFinancialLine", params)
        if not code_is_success(payload):
            raise RuntimeError("AddJobFinancialLine returned an error")
        line_id = find_identifier(payload, ("JobFinancialLineId", "LineItemId", "LineId", "Id", "ID"))
        if not line_id:
            raise RuntimeError("AddJobFinancialLine did not return a line id")
        return line_id

    def generate_financial_doc_for_job(self, params: dict[str, Any]) -> dict[str, Any]:
        payload = self.get("GenerateFinancialDocForJob", params)
        if not code_is_success(payload):
            raise RuntimeError("GenerateFinancialDocForJob returned an error")
        return payload


@dataclass
class InvoiceLine:
    source: dict[str, Any]
    line_number: int
    description: Any
    unit_price: Any
    quantity: Any
    item_cost: Any
    currency: str
    tax_code: Any
    tax_rate: Any
    nominal_code: str


@dataclass
class RunReport:
    temp_invoices_scanned: int = 0
    invoices_skipped: int = 0
    invoices_updated: int = 0
    lines_updated: int = 0
    invoices_where_temp_became_inv: list[dict[str, str]] = field(default_factory=list)
    failures: list[dict[str, str]] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "TEMP invoices scanned": self.temp_invoices_scanned,
            "invoices skipped": self.invoices_skipped,
            "invoices updated": self.invoices_updated,
            "lines updated": self.lines_updated,
            "invoices where TEMP became INV": self.invoices_where_temp_became_inv,
            "failures": self.failures,
        }


def invoice_reference(row: dict[str, Any]) -> str:
    return clean_text(first_present(row, ("Reference", "DocRef", "InvoiceReference", "InvoiceRef")))


def invoice_id(row: dict[str, Any]) -> str:
    return clean_text(first_present(row, ("InvoiceId", "DocId", "FinancialDocId", "Id", "ID")))


def is_target_invoice_row(row: dict[str, Any]) -> bool:
    invoice_type = clean_text(first_present(row, ("InvoiceType", "Type", "DocumentType"))).upper()
    return invoice_type == "SI" and invoice_reference(row).upper().startswith("TEMP")


def classify_nominal_code(job: dict[str, Any]) -> str:
    job_type = clean_text(first_present(job, ("Type", "JobType", "JobTypeName", "Category", "CategoryName")))
    description = clean_text(first_present(job, ("Description", "JobDescription", "Details", "Notes")))
    haystack = f"{job_type} {description}"
    discipline = classify_from_keywords(haystack, DISCIPLINE_KEYWORDS)
    work_type = classify_from_keywords(haystack, WORK_TYPE_KEYWORDS)
    if not discipline or not work_type:
        return FALLBACK_NOMINAL_CODE
    return DISCIPLINE_CODES.get((discipline, work_type), FALLBACK_NOMINAL_CODE)


def classify_from_keywords(text: str, groups: dict[str, tuple[str, ...]]) -> str | None:
    for group, keywords in groups.items():
        if any(contains_keyword(text, keyword) for keyword in keywords):
            return group
    return None


def document_is_processable(doc: dict[str, Any]) -> tuple[bool, str]:
    doc_type = clean_text(first_present(doc, ("DocumentType", "DocType", "financialDocType", "InvoiceType", "Type")))
    if doc_type:
        norm_doc_type = normalized_text(doc_type)
        if norm_doc_type not in {"invoice", "sales invoice", "si"} and "invoice" not in norm_doc_type:
            return False, f"document type is {doc_type}"
    for field_name in ("CancellationDate", "DeletionDate", "RejectionDate"):
        if is_populated(first_present(doc, (field_name,))):
            return False, f"{field_name} is populated"
    return True, ""


def extract_invoice_line(line: dict[str, Any], line_number: int) -> InvoiceLine:
    currency = clean_text(first_present(line, ("Currency", "CurrencyCode", "DefaultCurrency"))) or DEFAULT_CURRENCY
    nominal = clean_text(first_present(line, ("NominalCode", "JWNominalCode")))
    return InvoiceLine(
        source=line,
        line_number=line_number,
        description=first_present(line, ("Description", "ItemDescription", "Name")),
        unit_price=first_present(line, ("UnitPrice", "Price", "NetPrice", "UnitNetPrice")),
        quantity=first_present(line, ("Quantity", "Qty")),
        item_cost=first_present(line, ("ItemCost", "Cost", "DefaultCost")),
        currency=currency,
        tax_code=first_present(line, ("TaxCode", "Vat", "VATCode", "VatCode")),
        tax_rate=first_present(line, ("TaxRate", "VatRate", "VATRate", "DefaultVat")),
        nominal_code=nominal,
    )


def line_has_nominal(line: InvoiceLine, expected_nominal: str) -> bool:
    return clean_text(line.nominal_code) == expected_nominal


def line_reference(temp_ref: str, nominal_code: str, line_number: int) -> str:
    safe_ref = re.sub(r"[^A-Za-z0-9_-]+", "-", temp_ref).strip("-")
    return f"AI-{safe_ref}-NOMINAL-{nominal_code}-{line_number}"


class TempInvoiceNominalCorrector:
    def __init__(self, client: BigChangeApi) -> None:
        self.client = client

    def run(self) -> RunReport:
        report = RunReport()
        rows = self.client.invoices_without_sync()
        unique_rows: dict[tuple[str, str], dict[str, Any]] = {}
        for row in rows:
            if not is_target_invoice_row(row):
                continue
            ref = invoice_reference(row)
            inv_id = invoice_id(row)
            unique_rows[(ref, inv_id)] = row

        report.temp_invoices_scanned = len(unique_rows)
        for row in unique_rows.values():
            ref = invoice_reference(row)
            try:
                outcome = self.process_invoice(row, report)
                if outcome == "skipped":
                    report.invoices_skipped += 1
                elif outcome == "updated":
                    report.invoices_updated += 1
            except Exception as exc:
                report.failures.append({"reference": ref or invoice_id(row), "reason": str(exc)})
        return report

    def process_invoice(self, row: dict[str, Any], report: RunReport) -> str:
        ref = invoice_reference(row)
        inv_id = invoice_id(row)
        doc = self.client.financial_doc(doc_ref=ref)
        if doc is None and inv_id:
            doc = self.client.financial_doc(doc_id=inv_id)
        if doc is None:
            raise RuntimeError("FinancialDoc lookup failed by reference and id")

        doc_ref = clean_text(first_present(doc, ("Reference", "DocRef", "InvoiceReference", "InvoiceRef")))
        if doc_ref and not doc_ref.upper().startswith("TEMP"):
            return "skipped"

        processable, reason = document_is_processable(doc)
        if not processable:
            return "skipped"

        doc_id = clean_text(first_present(doc, ("DocId", "FinancialDocId", "InvoiceId", "Id", "ID"))) or inv_id
        if not doc_id:
            raise RuntimeError("FinancialDoc did not include DocId")

        job, job_id = self.identify_job(doc)
        if not job or not job_id:
            raise RuntimeError("linked job could not be identified")

        target_nominal = classify_nominal_code(job)
        raw_lines = extract_lines(doc)
        if not raw_lines:
            raise RuntimeError("FinancialDoc did not include FinancialLine rows")
        lines = [extract_invoice_line(line, index + 1) for index, line in enumerate(raw_lines)]
        changed_count = sum(1 for line in lines if not line_has_nominal(line, target_nominal))
        if changed_count == 0:
            return "skipped"

        replacement_line_ids = self.create_replacement_lines(ref, job_id, target_nominal, lines)
        self.client.generate_financial_doc_for_job(
            {
                "JobId": job_id,
                "financialDocType": "Invoice",
                "DocId": doc_id,
                "lineItemIds": ",".join(replacement_line_ids),
            }
        )

        verified_doc = self.client.financial_doc(doc_id=doc_id)
        if verified_doc is None:
            raise RuntimeError("FinancialDoc disappeared after regeneration")
        self.verify_document(verified_doc, lines, target_nominal)
        new_ref = clean_text(first_present(verified_doc, ("Reference", "DocRef", "InvoiceReference", "InvoiceRef")))
        if ref.upper().startswith("TEMP") and new_ref.upper().startswith("INV") and new_ref != ref:
            report.invoices_where_temp_became_inv.append({"from": ref, "to": new_ref})
        report.lines_updated += changed_count
        return "updated"

    def identify_job(self, doc: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
        job_id = clean_text(first_present(doc, ("JobId", "JobID", "LinkedJobId")))
        job_ref = clean_text(first_present(doc, ("JobReference", "JobRef", "JobNumber")))
        job = self.client.job(job_id=job_id) if job_id else None
        if job is None and job_ref:
            job = self.client.job(job_ref=job_ref)
            job_id = clean_text(first_present(job or {}, ("JobId", "JobID", "Id", "ID"))) or job_id
        if job is None:
            job = self.first_group_job(doc)
            job_id = clean_text(first_present(job or {}, ("JobId", "JobID", "Id", "ID"))) or job_id
        return job, job_id or None

    def first_group_job(self, doc: dict[str, Any]) -> dict[str, Any] | None:
        embedded = self.first_embedded_group_job(doc)
        if embedded:
            return embedded
        group_id = clean_text(first_present(doc, ("GroupId", "JobGroupId", "GroupReference", "GroupRef")))
        if not group_id:
            return None
        jobs = self.client.group_jobs(group_id)
        return jobs[0] if jobs else None

    def first_embedded_group_job(self, value: Any) -> dict[str, Any] | None:
        if isinstance(value, dict):
            for key, nested in value.items():
                if "job" in compact_key(key):
                    rows = nested_rows(nested)
                    for row in rows:
                        if first_present(row, ("JobId", "JobReference", "JobRef")):
                            return row
                found = self.first_embedded_group_job(nested)
                if found:
                    return found
        elif isinstance(value, list):
            for item in value:
                found = self.first_embedded_group_job(item)
                if found:
                    return found
        return None

    def create_replacement_lines(
        self,
        ref: str,
        job_id: str,
        target_nominal: str,
        lines: list[InvoiceLine],
    ) -> list[str]:
        replacement_line_ids: list[str] = []
        for line in lines:
            predefined_item_id = self.client.create_predefined_inv_item(
                {
                    "Reference": line_reference(ref, target_nominal, line.line_number),
                    "Description": line.description,
                    "UnitPrice": line.unit_price,
                    "Vat": line.tax_code,
                    "DefaultCurrency": line.currency or DEFAULT_CURRENCY,
                    "DefaultCost": line.item_cost if line.item_cost not in (None, "") else "0",
                    "DefaultVat": line.tax_rate,
                    "NominalCode": target_nominal,
                }
            )
            replacement_line_id = self.client.add_job_financial_line(
                {
                    "JobId": job_id,
                    "PredefinedItemId": predefined_item_id,
                    "ItemType": "predefined",
                    "Description": line.description,
                    "CurrencyCode": line.currency or DEFAULT_CURRENCY,
                    "Quantity": line.quantity,
                    "NominalCode": target_nominal,
                }
            )
            replacement_line_ids.append(replacement_line_id)
        return replacement_line_ids

    def verify_document(
        self,
        verified_doc: dict[str, Any],
        original_lines: list[InvoiceLine],
        expected_nominal: str,
    ) -> None:
        verified_lines = [extract_invoice_line(line, index + 1) for index, line in enumerate(extract_lines(verified_doc))]
        if len(verified_lines) != len(original_lines):
            raise RuntimeError(
                f"verification line count changed from {len(original_lines)} to {len(verified_lines)}"
            )
        for original, verified in zip(original_lines, verified_lines, strict=True):
            if not line_has_nominal(verified, expected_nominal):
                raise RuntimeError(f"line {original.line_number} nominal code was not updated")
            if not decimal_equal(original.unit_price, verified.unit_price):
                raise RuntimeError(f"line {original.line_number} UnitPrice changed")
            if not decimal_equal(original.quantity, verified.quantity):
                raise RuntimeError(f"line {original.line_number} Quantity changed")
            if clean_text(original.tax_code) and clean_text(original.tax_code) != clean_text(verified.tax_code):
                raise RuntimeError(f"line {original.line_number} TaxCode changed")
            if clean_text(original.tax_rate) and not decimal_equal(original.tax_rate, verified.tax_rate):
                raise RuntimeError(f"line {original.line_number} TaxRate changed")


def main() -> int:
    try:
        report = TempInvoiceNominalCorrector(BigChangeClient()).run()
        print(json.dumps(report.as_dict(), indent=2, sort_keys=False))
        return 0 if not report.failures else 1
    except ConfigError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"BigChange TEMP invoice nominal correction failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
