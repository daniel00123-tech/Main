#!/usr/bin/env python3
"""Correct VAT codes on unsynchronised BigChange TEMP sales invoices.

The runner is intentionally conservative: it only touches TEMP sales invoices,
updates existing financial documents by DocId, and refuses invoices whose line
data cannot be preserved and verified.
"""

from __future__ import annotations

import argparse
import base64
import csv
import io
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, OrderedDict
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any


ACCEPTED_TAX_CODES = {
    "20% (VAT on Income)",
    "20% (aVAT on Income)",
    "Domestic Reverse Charge @ 20% (VAT on Income)",
}

TARGET_TAX_CODE = "20% (VAT on Income)"
DEFAULT_BASE_URL = "https://webservice.bigchange.com/v01/services.ashx"
SUPPORTED_AUTH_MODES = {"api_key", "api_key_basic"}


class BigChangeError(Exception):
    """Raised when a BigChange request or response is not usable."""


@dataclass(frozen=True)
class FinancialLine:
    line_no: int
    raw: dict[str, Any]
    description: str
    unit_price: Decimal
    quantity: Decimal
    item_cost: Decimal | None
    currency: str
    nominal_code: str | None
    tax_code: str | None
    line_item_id: str | None


@dataclass
class Report:
    temp_invoices_scanned: int = 0
    invoices_skipped: int = 0
    invoices_corrected: int = 0
    lines_corrected: int = 0
    invoices_converted_temp_to_inv: int = 0
    failures: list[str] | None = None

    def __post_init__(self) -> None:
        if self.failures is None:
            self.failures = []

    def fail(self, reference: str, reason: str) -> None:
        assert self.failures is not None
        self.failures.append(f"{reference}: {reason}")


class BigChangeClient:
    def __init__(
        self,
        base_url: str,
        api_key: str | None,
        username: str | None,
        password: str | None,
        auth_mode: str,
        timeout: float,
        dry_run: bool = False,
    ) -> None:
        self.base_url = base_url
        self.api_key = api_key
        self.username = username
        self.password = password
        self.auth_mode = auth_mode
        self.timeout = timeout
        self.dry_run = dry_run

    def call(self, action: str, params: dict[str, Any] | None = None) -> Any:
        payload = {"action": action, "format": "JSON"}
        if params:
            payload.update({k: v for k, v in params.items() if v is not None})

        if self.dry_run and action not in {"InvoicesWithoutSync", "FinancialDoc"}:
            raise BigChangeError(f"dry-run blocked mutating action {action}")

        url = self._url(payload)
        request = urllib.request.Request(url, headers=self._headers())
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = response.read().decode("utf-8-sig")
        except urllib.error.HTTPError as exc:
            text = exc.read().decode("utf-8-sig", errors="replace")
            raise BigChangeError(f"{action} HTTP {exc.code}: {trim(text)}") from exc
        except urllib.error.URLError as exc:
            raise BigChangeError(f"{action} request failed: {exc.reason}") from exc

        return parse_response(action, body)

    def _url(self, params: dict[str, Any]) -> str:
        query = urllib.parse.urlencode(
            {key: serialise_param(value) for key, value in params.items()},
            doseq=False,
        )
        separator = "&" if urllib.parse.urlparse(self.base_url).query else "?"
        return f"{self.base_url}{separator}{query}"

    def _headers(self) -> dict[str, str]:
        headers = {"Accept": "application/json"}
        if self.api_key:
            # BigChange calls this the company "key" in the web service docs.
            headers["key"] = self.api_key
        if self.auth_mode == "api_key_basic" and self.username and self.password:
            token = base64.b64encode(f"{self.username}:{self.password}".encode("utf-8")).decode("ascii")
            headers["Authorization"] = f"Basic {token}"
        return headers


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    auth_mode = normalise_auth_mode(os.environ.get("BIGCHANGE_AUTH_MODE"))
    client = BigChangeClient(
        base_url=os.environ.get("BIGCHANGE_BASE_URL", DEFAULT_BASE_URL),
        api_key=os.environ.get("BIGCHANGE_API_KEY"),
        username=os.environ.get("BIGCHANGE_USERNAME"),
        password=os.environ.get("BIGCHANGE_PASSWORD"),
        auth_mode=auth_mode,
        timeout=args.timeout,
        dry_run=args.dry_run,
    )

    if auth_mode not in SUPPORTED_AUTH_MODES:
        print_report(Report(failures=[f"configuration: unsupported BIGCHANGE_AUTH_MODE {auth_mode}"]))
        return 2

    missing = required_env_missing(auth_mode)
    if missing:
        print_report(Report(failures=[f"configuration: missing {', '.join(missing)}"]))
        return 2

    report = run_correction(client, pause_seconds=args.pause_seconds)
    print_report(report)
    return 1 if report.failures else 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument("--pause-seconds", type=float, default=1.0)
    parser.add_argument("--dry-run", action="store_true", help="Allow reads but block writes.")
    return parser.parse_args(argv)


def normalise_auth_mode(value: str | None) -> str:
    return clean_str(value or "api_key_basic").lower()


def required_env_missing(auth_mode: str) -> list[str]:
    missing = []
    names = ["BIGCHANGE_API_KEY"]
    if auth_mode == "api_key_basic":
        names.extend(["BIGCHANGE_USERNAME", "BIGCHANGE_PASSWORD"])
    for name in names:
        if not os.environ.get(name):
            missing.append(name)
    return missing


def run_correction(client: BigChangeClient, pause_seconds: float) -> Report:
    report = Report()
    try:
        invoice_rows = as_list(client.call("InvoicesWithoutSync"))
    except BigChangeError as exc:
        report.fail("InvoicesWithoutSync", str(exc))
        return report

    invoices = group_temp_sales_invoices(invoice_rows)
    report.temp_invoices_scanned = len(invoices)

    for invoice_key, invoice in invoices.items():
        reference = str(invoice["reference"])
        doc_id = invoice["doc_id"]
        try:
            outcome = process_invoice(client, reference, doc_id, pause_seconds)
        except BigChangeError as exc:
            report.fail(reference, str(exc))
            continue

        if outcome["skipped"]:
            report.invoices_skipped += 1
            continue

        report.invoices_corrected += 1
        report.lines_corrected += int(outcome["lines_corrected"])
        if outcome["converted_temp_to_inv"]:
            report.invoices_converted_temp_to_inv += 1

    return report


def group_temp_sales_invoices(rows: list[Any]) -> "OrderedDict[str, dict[str, Any]]":
    grouped: OrderedDict[str, dict[str, Any]] = OrderedDict()
    for row in rows:
        if not isinstance(row, dict):
            continue
        invoice_type = get_first(row, "InvoiceType", "invoiceType", "Type", "type")
        if str(invoice_type or "").strip().upper() != "SI":
            continue

        reference = clean_str(get_first(row, "Reference", "reference", "InvoiceReference", "InvoiceRef", "DocRef"))
        if not reference.startswith("TEMP"):
            continue

        doc_id = clean_str(
            get_first(
                row,
                "InvoiceId",
                "InvoiceID",
                "FinancialDocId",
                "FinancialDocID",
                "DocId",
                "DocumentId",
                "Id",
            )
        )
        if not doc_id:
            grouped[f"{reference}|missing"] = {"reference": reference, "doc_id": None}
            continue

        grouped.setdefault(f"{reference}|{doc_id}", {"reference": reference, "doc_id": doc_id})
    return grouped


def process_invoice(
    client: BigChangeClient,
    reference: str,
    doc_id: str | None,
    pause_seconds: float,
) -> dict[str, Any]:
    if not doc_id:
        raise BigChangeError("InvoiceId is missing")

    doc = read_financial_doc(client, doc_id)
    job_id = clean_str(get_first(doc, "JobId", "JobID", "jobId"))
    actual_doc_id = clean_str(get_first(doc, "DocId", "DocumentId", "FinancialDocId", "Id")) or doc_id
    if not job_id:
        raise BigChangeError("JobId is missing")
    if str(actual_doc_id) != str(doc_id):
        raise BigChangeError(f"FinancialDoc returned unexpected DocId {actual_doc_id}")

    raw_lines = extract_lines(doc)
    if not raw_lines:
        raise BigChangeError("FinancialDoc has no FinancialLine rows")

    lines = [normalise_line(line, idx + 1) for idx, line in enumerate(raw_lines)]
    needs_correction = [line for line in lines if line.tax_code not in ACCEPTED_TAX_CODES]
    if not needs_correction:
        return {"skipped": True}

    line_item_ids: list[str] = []
    replacement_count = 0
    job_lines = load_job_financial_lines(client, job_id)
    for line in lines:
        if line.tax_code in ACCEPTED_TAX_CODES:
            if not line.line_item_id:
                raise BigChangeError(f"accepted line {line.line_no} is missing a job financial line id")
            line_item_ids.append(line.line_item_id)
            continue

        replacement_reference = predefined_reference(reference, line)
        new_line_id = find_existing_replacement_line(job_lines, replacement_reference, line)
        if not new_line_id:
            predefined_id = create_predefined_item(client, replacement_reference, line)
            new_line_id = add_job_financial_line(client, job_id, predefined_id, line)
        if not new_line_id:
            raise BigChangeError(f"replacement line {line.line_no} cannot be created")
        line_item_ids.append(new_line_id)
        replacement_count += 1

    client.call(
        "GenerateFinancialDocForJob",
        {
            "JobId": job_id,
            "financialDocType": "Invoice",
            "DocId": doc_id,
            "lineItemIds": ",".join(line_item_ids),
        },
    )

    if pause_seconds > 0:
        time.sleep(pause_seconds)

    verify_regeneration(client, doc_id, reference, lines)
    verified_doc = read_financial_doc(client, doc_id)
    verified_ref = clean_str(get_first(verified_doc, "Reference", "DocRef", "DocumentReference", "InvoiceRef"))
    return {
        "skipped": False,
        "lines_corrected": replacement_count,
        "converted_temp_to_inv": reference.startswith("TEMP") and verified_ref.startswith("INV"),
    }


def read_financial_doc(client: BigChangeClient, doc_id: str) -> dict[str, Any]:
    response = client.call("FinancialDoc", {"docId": doc_id, "IncludeAllDocTypes": "true"})
    doc = unwrap_single_document(response)
    if not isinstance(doc, dict):
        raise BigChangeError("FinancialDoc cannot be read by docId")
    return doc


def load_job_financial_lines(client: BigChangeClient, job_id: str) -> list[FinancialLine]:
    response = client.call("JobFinancialLines", {"JobId": job_id})
    job_lines = []
    for idx, raw_line in enumerate(as_list(response), start=1):
        try:
            job_lines.append(normalise_line(raw_line, idx))
        except BigChangeError:
            continue
    return job_lines


def predefined_reference(invoice_reference: str, line: FinancialLine) -> str:
    return f"AI-{invoice_reference}-VATFIX-{line.line_no}"


def find_existing_replacement_line(
    job_lines: list[FinancialLine],
    replacement_reference: str,
    original_line: FinancialLine,
) -> str | None:
    for job_line in job_lines:
        item_reference = clean_str(get_first(job_line.raw, "ItemReference", "Reference", "InvoiceDefaultReference"))
        if item_reference != replacement_reference:
            continue
        if replacement_line_matches(job_line, original_line):
            return job_line.line_item_id
        raise BigChangeError(f"existing replacement line {replacement_reference} does not preserve original values")
    return None


def replacement_line_matches(job_line: FinancialLine, original_line: FinancialLine) -> bool:
    return (
        job_line.description == original_line.description
        and money_decimal(job_line.unit_price) == money_decimal(original_line.unit_price)
        and quantity_decimal(job_line.quantity) == quantity_decimal(original_line.quantity)
        and (job_line.nominal_code or None) == (original_line.nominal_code or None)
        and job_line.tax_code in ACCEPTED_TAX_CODES
        and bool(job_line.line_item_id)
    )


def create_predefined_item(client: BigChangeClient, replacement_reference: str, line: FinancialLine) -> str:
    params: dict[str, Any] = {
        "Reference": replacement_reference,
        "Description": line.description,
        "UnitPrice": decimal_to_param(line.unit_price),
        "Vat": TARGET_TAX_CODE,
        "DefaultCurrency": line.currency,
        "DefaultCost": decimal_to_param(line.item_cost or Decimal("0")),
        "DefaultVat": "20",
    }
    if line.nominal_code:
        params["NominalCode"] = line.nominal_code

    response = client.call("CreatePredefinedInvItem", params)
    predefined_id = extract_identifier(
        response,
        "InvoiceDefaultId",
        "InvoiceDefaultID",
        "PreDefinedItemId",
        "PredefinedItemId",
        "PredefinedInvItemId",
        "Id",
    )
    if not predefined_id:
        raise BigChangeError(f"predefined item for line {line.line_no} cannot be created")
    return predefined_id


def add_job_financial_line(client: BigChangeClient, job_id: str, predefined_id: str, line: FinancialLine) -> str:
    params: dict[str, Any] = {
        "JobId": job_id,
        "PredefinedItemId": predefined_id,
        "ItemType": "predefined",
        "Description": line.description,
        "CurrencyCode": line.currency,
        "Quantity": decimal_to_param(line.quantity),
        "UnitPrice": decimal_to_param(line.unit_price),
    }
    if line.item_cost is not None:
        params["Cost"] = decimal_to_param(line.item_cost)
    if line.nominal_code:
        params["NominalCode"] = line.nominal_code

    response = client.call("AddJobFinancialLine", params)
    return extract_identifier(
        response,
        "invoiceItemId",
        "InvoiceItemId",
        "InvoiceItemID",
        "LineId",
        "LineID",
        "FinancialLineId",
        "FinancialLineID",
        "Id",
    )


def verify_regeneration(
    client: BigChangeClient,
    doc_id: str,
    original_reference: str,
    original_lines: list[FinancialLine],
) -> None:
    doc = read_financial_doc(client, doc_id)
    verified_doc_id = clean_str(get_first(doc, "DocId", "DocumentId", "FinancialDocId", "Id"))
    if str(verified_doc_id or doc_id) != str(doc_id):
        raise BigChangeError("verification failed: document does not exist by DocId")

    verified_lines = [normalise_line(line, idx + 1) for idx, line in enumerate(extract_lines(doc))]
    if len(verified_lines) != len(original_lines):
        raise BigChangeError("verification failed: line count changed")

    for line in verified_lines:
        if line.tax_code not in ACCEPTED_TAX_CODES:
            raise BigChangeError(f"verification failed: line {line.line_no} tax code is not accepted")

    original_counts = Counter(line_signature(line) for line in original_lines)
    verified_counts = Counter(line_signature(line) for line in verified_lines)
    if original_counts != verified_counts:
        raise BigChangeError("verification failed: line description, price, quantity, or nominal was not preserved")

    verified_ref = clean_str(get_first(doc, "Reference", "DocRef", "DocumentReference", "InvoiceRef"))
    if verified_ref and verified_ref.startswith("INV"):
        return
    if verified_ref and verified_ref != original_reference:
        raise BigChangeError("verification failed: document reference changed unexpectedly")


def line_signature(line: FinancialLine) -> tuple[str, Decimal, Decimal, str | None]:
    return (line.description, money_decimal(line.unit_price), quantity_decimal(line.quantity), line.nominal_code)


def normalise_line(raw: Any, line_no: int) -> FinancialLine:
    if not isinstance(raw, dict):
        raise BigChangeError(f"line {line_no} is not an object")

    description = clean_str(get_first(raw, "Description", "description", "ItemDescription", "itemDescription"))
    currency = clean_str(get_first(raw, "Currency", "currency", "CurrencyCode", "currencyCode")) or "GBP"
    nominal_code = clean_str(get_first(raw, "NominalCode", "nominalCode", "NominalAccountCode", "nominalAccountCode"))
    tax_code = clean_str(get_first(raw, "TaxCode", "taxCode", "InvoiceVatCode", "invoiceVatCode", "Vat", "VAT"))
    line_item_id = clean_str(
        get_first(
            raw,
            "InvoiceItemId",
            "InvoiceItemID",
            "invoiceItemId",
            "LineItemId",
            "LineItemID",
            "FinancialLineId",
            "FinancialLineID",
            "JobFinancialLineId",
            "JobFinancialLineID",
            "LineId",
            "LineID",
            "Id",
        )
    )

    if not description:
        raise BigChangeError(f"line {line_no} is missing Description")
    if not currency:
        raise BigChangeError(f"line {line_no} is missing Currency")

    unit_price = parse_decimal_required(raw, line_no, "UnitPrice", "unitPrice")
    quantity = parse_decimal_required(raw, line_no, "Quantity", "quantity", "LineQuantity", "lineQuantity")
    item_cost = parse_decimal_optional(raw, "ItemCost", "itemCost", "Cost", "cost", "CostPrice", "costPrice")

    return FinancialLine(
        line_no=line_no,
        raw=raw,
        description=description,
        unit_price=unit_price,
        quantity=quantity,
        item_cost=item_cost,
        currency=currency,
        nominal_code=nominal_code or None,
        tax_code=tax_code or None,
        line_item_id=line_item_id or None,
    )


def extract_lines(doc: dict[str, Any]) -> list[Any]:
    for key in (
        "FinancialLines",
        "FinancialLine",
        "Lines",
        "LineItems",
        "Items",
        "InvoiceItems",
        "DocumentLines",
    ):
        value = get_case_insensitive(doc, key)
        if value is None:
            continue
        return as_list(value)
    return []


def parse_response(action: str, body: str) -> Any:
    text = body.strip()
    if not text:
        return None
    if text[:1] not in "[{":
        return parse_csv_or_text(text)

    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise BigChangeError(f"{action} returned invalid JSON: {exc}") from exc

    if isinstance(data, dict) and "Code" in data:
        code = str(data.get("Code"))
        result = data.get("Result")
        if code != "0":
            raise BigChangeError(f"{action} returned Code {code}: {trim(result)}")
        return result
    return data


def parse_csv_or_text(text: str) -> Any:
    if "," not in text and "\n" not in text:
        return text
    rows = list(csv.DictReader(io.StringIO(text)))
    return rows if rows else text


def unwrap_single_document(response: Any) -> Any:
    if isinstance(response, dict):
        for key in ("FinancialDoc", "Document", "Invoice"):
            value = get_case_insensitive(response, key)
            if value is not None:
                return unwrap_single_document(value)
        return response
    values = as_list(response)
    if len(values) == 1:
        return unwrap_single_document(values[0])
    return response


def extract_identifier(response: Any, *keys: str, allow_scalar: bool = True) -> str:
    if isinstance(response, (str, int)):
        if not allow_scalar:
            return ""
        return clean_str(response)
    if isinstance(response, dict):
        for key in keys:
            value = get_case_insensitive(response, key)
            if value is not None:
                return clean_str(value)
        result = get_case_insensitive(response, "Result")
        if result is not None:
            return extract_identifier(result, *keys)
        if looks_like_numbered_container(response):
            for _, value in sorted_numbered_items(response):
                identifier = extract_identifier(value, *keys, allow_scalar=False)
                if identifier:
                    return identifier
        for value in response.values():
            if isinstance(value, (dict, list)):
                identifier = extract_identifier(value, *keys, allow_scalar=False)
                if identifier:
                    return identifier
        return ""
    if isinstance(response, list):
        for value in response:
            identifier = extract_identifier(value, *keys, allow_scalar=False)
            if identifier:
                return identifier
    return ""


def as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        # XML-like JSON often serialises repeated nodes as {"FinancialLine": [...]}.
        if len(value) == 1:
            only = next(iter(value.values()))
            if isinstance(only, list):
                return only
            if isinstance(only, dict) and looks_like_numbered_container(value):
                return [only]
        if looks_like_numbered_container(value):
            return [line for _, line in sorted_numbered_items(value)]
        return [value]
    return [value]


def looks_like_numbered_container(value: dict[str, Any]) -> bool:
    return bool(value) and all(key.rsplit(" ", 1)[-1].isdigit() for key in value)


def sorted_numbered_items(value: dict[str, Any]) -> list[tuple[str, Any]]:
    def sort_key(item: tuple[str, Any]) -> tuple[str, int]:
        key, _ = item
        prefix, _, suffix = key.rpartition(" ")
        return (prefix, int(suffix) if suffix.isdigit() else 0)

    return sorted(value.items(), key=sort_key)


def get_first(data: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = get_case_insensitive(data, key)
        if value is not None:
            return value
    return None


def get_case_insensitive(data: dict[str, Any], key: str) -> Any:
    if key in data:
        return data[key]
    target = key.lower()
    for actual, value in data.items():
        if actual.lower() == target:
            return value
    return None


def parse_decimal_required(raw: dict[str, Any], line_no: int, *keys: str) -> Decimal:
    value = get_first(raw, *keys)
    if value in (None, ""):
        raise BigChangeError(f"line {line_no} is missing {keys[0]}")
    try:
        return Decimal(str(value).strip())
    except InvalidOperation as exc:
        raise BigChangeError(f"line {line_no} has invalid {keys[0]}") from exc


def parse_decimal_optional(raw: dict[str, Any], *keys: str) -> Decimal | None:
    value = get_first(raw, *keys)
    if value in (None, ""):
        return None
    try:
        return Decimal(str(value).strip())
    except InvalidOperation as exc:
        raise BigChangeError(f"line has invalid {keys[0]}") from exc


def money_decimal(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.0001"))


def quantity_decimal(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.0001"))


def decimal_to_param(value: Decimal) -> str:
    return format(value.normalize(), "f")


def clean_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def serialise_param(value: Any) -> str:
    if isinstance(value, Decimal):
        return decimal_to_param(value)
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def trim(value: Any, limit: int = 200) -> str:
    text = clean_str(value)
    return text if len(text) <= limit else f"{text[:limit]}..."


def print_report(report: Report) -> None:
    failures = report.failures or []
    print(f"TEMP invoices scanned: {report.temp_invoices_scanned}")
    print(f"invoices skipped: {report.invoices_skipped}")
    print(f"invoices corrected: {report.invoices_corrected}")
    print(f"lines corrected: {report.lines_corrected}")
    print(f"invoices converted by BigChange from TEMP to INV: {report.invoices_converted_temp_to_inv}")
    print(f"failures: {len(failures)}")
    for failure in failures:
        print(f"- {failure}")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
