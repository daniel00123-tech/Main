# Main

## Cursor Agent quick start

For the recurring BigChange TEMP invoice VAT correction, do **not** rediscover
the API or build a one-off client. Run the checked-in entrypoint:

```bash
./run_bigchange_temp_vat_fix.sh
```

If the shell does not already have the BigChange variables set, pass them in
from the automation trigger context without printing them.

## Daily BigChange TEMP invoice VAT correction

The entrypoint above calls the committed runner:

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
