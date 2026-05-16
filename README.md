# Main

## Daily BigChange TEMP invoice VAT correction

Use the committed runner instead of rediscovering the BigChange API details:

```bash
python3 scripts/bigchange_temp_vat_fix.py
```

Required environment variables:

- `BIGCHANGE_BASE_URL`
- `BIGCHANGE_API_KEY`
- `BIGCHANGE_USERNAME`
- `BIGCHANGE_PASSWORD`

The runner:

- calls `InvoicesWithoutSync`
- processes only sales invoices (`InvoiceType = SI`) whose reference starts with `TEMP`
- reads each invoice with `FinancialDoc`
- skips invoices whose lines already use accepted VAT codes
- creates temporary predefined items and replacement job financial lines when needed
- updates the existing document with `GenerateFinancialDocForJob` using `DocId`
- verifies the regenerated document by `DocId`

Do not call `InvoiceSetStatus`, send invoices, download PDFs, or process credit notes/`INV` references for this automation.
