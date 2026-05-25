# Aquilo BigChange KPI Overview Report

Daily automation that gathers BigChange legacy Web Services KPI data and Freshdesk open-ticket data, renders a dark KPI dashboard to PNG, embeds and attaches the PNG in the report email, and saves the run baseline to `automation-memory/kpi-baseline.json`.

Job KPIs are grouped by BigChange job category staff owner and limited to jobs from the last 12 months. Current-month sales use invoice financial documents from the first of the current month through today. Sales are attributed to the latest linked job customer activity with client status `InvoiceCreated`, matching the creator back to the job category staff name. The calculation uses line `NetPrice - VatAmount` to report ex-VAT values and includes both synchronised and unsynchronised documents returned by `InvoicesWithItemsByPeriod`.

Freshdesk open tickets are fetched with pagination, spam/deleted tickets are ignored, owners are matched back to BigChange staff rows, and unmatched tickets are counted without creating orphan dashboard rows.

Run with the required BigChange, Freshdesk, and SMTP configuration supplied as environment variables:

```sh
python3 scripts/bigchange_kpi_report.py
```

The scheduled workflow is named **Aquilo BigChange KPI Overview Report** and runs daily at `07:00 UTC`. Configure the required values as repository secrets using the environment variable names referenced by `scripts/bigchange_kpi_report.py`; do not commit credential values to the repository.

## BigChange TEMP Invoice Nominal Correction

Hourly automation entry point for correcting unsynchronised TEMP sales invoice line nominal codes:

```sh
python3 scripts/bigchange_temp_invoice_nominals.py
```

It reads `InvoicesWithoutSync`, processes only `SI` references beginning with `TEMP`, skips cancelled/deleted/rejected or non-invoice documents, updates the existing financial document by `DocId`, and prints only the scan/update/failure summary.
