# Aquilo BigChange KPI Overview Report

Daily automation that gathers BigChange legacy Web Services KPI data and Freshdesk open-ticket data, renders a dark KPI dashboard to PNG, embeds and attaches the PNG in the report email, and saves the run baseline to `automation-memory/kpi-baseline.json`.

Job KPIs are grouped by BigChange job category staff owner and limited to jobs from the last 12 months. Current-month sales use invoice financial documents from the first of the current month through today. Sales are attributed to the latest linked job customer activity with client status `InvoiceCreated`, matching the creator back to the job category staff name. The calculation uses line `NetPrice - VatAmount` to report ex-VAT values and includes both synchronised and unsynchronised documents returned by `InvoicesWithItemsByPeriod`.

Freshdesk open tickets are fetched with pagination, spam/deleted tickets are ignored, owners are matched back to BigChange staff rows, and unmatched tickets are counted without creating orphan dashboard rows.

Run with the required BigChange, Freshdesk, and SMTP configuration supplied as environment variables:

```sh
python3 scripts/bigchange_kpi_report.py
```

## Daily workflow

`.github/workflows/aquilo-bigchange-kpi-overview-report.yml` runs the report every day at 07:00 UTC and can also be triggered manually. The workflow:

- Supplies BigChange, Freshdesk, and SMTP settings from repository secrets.
- Renders `reports/bigchange-kpi-dashboard.png`, embeds it in the email body, and attaches only that PNG.
- Uploads only the PNG as a workflow artifact.
- Commits `automation-memory/kpi-baseline.json` after successful runs so later follow-up automations can compare against the daily baseline.

Optional repository variables:

- `FRESHDESK_OPEN_STATUS_IDS` for overriding Freshdesk open status IDs.
- `STAFF_NAME_ALIASES` for runtime staff-name matching aliases, formatted as `Alias=Canonical Name` entries separated by commas, semicolons, or newlines.

## BigChange TEMP Invoice Nominal Correction

Hourly automation entry point for correcting unsynchronised TEMP sales invoice line nominal codes:

```sh
python3 scripts/bigchange_temp_invoice_nominals.py
```

It reads `InvoicesWithoutSync`, processes only `SI` references beginning with `TEMP`, skips cancelled/deleted/rejected or non-invoice documents, updates the existing financial document by `DocId`, and prints only the scan/update/failure summary.
