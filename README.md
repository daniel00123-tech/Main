# Aquilo BigChange KPI Overview Report

Daily automation that gathers BigChange legacy Web Services KPI data and Freshdesk open-ticket data, renders a dark KPI dashboard to PNG, embeds and attaches the PNG in the report email, and saves the run baseline to `automation-memory/kpi-baseline.json`.

Job KPIs are grouped by BigChange job category staff owner and limited to jobs from the last 12 months. Current-month sales use invoice financial documents from the first of the current month through today. Sales are attributed to the latest linked job customer activity with client status `InvoiceCreated`, matching the creator back to the job category staff name. The calculation uses line `NetPrice - VatAmount` to report ex-VAT values and includes both synchronised and unsynchronised documents returned by `InvoicesWithItemsByPeriod`.

Freshdesk open tickets are fetched with pagination, spam/deleted tickets are ignored, owners are matched back to BigChange staff rows, and unmatched tickets are counted without creating orphan dashboard rows.

Run with the required BigChange, Freshdesk, and SMTP configuration supplied as environment variables:

```sh
python3 scripts/bigchange_kpi_report.py
```

## Daily schedule

The GitHub Actions workflow `.github/workflows/aquilo-bigchange-kpi-overview-report.yml` is named
`Aquilo BigChange KPI Overview Report` and runs every day at 07:00 UTC. It can also be started manually with
`workflow_dispatch`.

Configure these repository secrets before enabling the workflow:

- `BIGCHANGE_BASE_URL`
- `BIGCHANGE_API_KEY`
- `BIGCHANGE_USERNAME`
- `BIGCHANGE_PASSWORD`
- `FRESHDESK_SUBDOMAIN`
- `FRESHDESK_API_KEY`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USERNAME`
- `SMTP_PASSWORD`
- `SMTP_FROM_EMAIL`
- `SMTP_FROM_NAME`
- `SMTP_TO_EMAIL`
- `SMTP_CC_EMAIL`
- `STAFF_NAME_ALIASES` (optional, comma-separated `alias=canonical name` entries)

The workflow sets `BIGCHANGE_AUTH_MODE=api_key`, runs `python3 scripts/bigchange_kpi_report.py`, uploads only
`reports/bigchange-kpi-dashboard.png` as a workflow artifact, and commits any updated
`automation-memory/kpi-baseline.json` snapshot for midday follow-up automations.

## BigChange TEMP Invoice Nominal Correction

Hourly automation entry point for correcting unsynchronised TEMP sales invoice line nominal codes:

```sh
python3 scripts/bigchange_temp_invoice_nominals.py
```

It reads `InvoicesWithoutSync`, processes only `SI` references beginning with `TEMP`, skips cancelled/deleted/rejected or non-invoice documents, updates the existing financial document by `DocId`, and prints only the scan/update/failure summary.
