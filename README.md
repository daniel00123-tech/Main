# Aquilo BigChange KPI Overview Report

Daily automation that gathers BigChange legacy Web Services KPI data and Freshdesk open-ticket data, renders a dark KPI dashboard to PNG, embeds and attaches the PNG in the report email, and saves the run baseline to `automation-memory/kpi-baseline.json`.

Job KPIs are grouped by BigChange job category staff owner and limited to jobs from the last 12 months. Current-month sales use invoice financial documents from the first of the current month through today. Sales are attributed to the latest linked job customer activity with client status `InvoiceCreated`, matching the creator back to the job category staff name. The calculation uses line `NetPrice - VatAmount` to report ex-VAT values and includes both synchronised and unsynchronised documents returned by `InvoicesWithItemsByPeriod`.

Freshdesk open tickets are fetched with pagination, spam/deleted tickets are ignored, owners are matched back to BigChange staff rows, and unmatched tickets are counted without creating orphan dashboard rows.

Run with the required BigChange, Freshdesk, and SMTP configuration supplied as environment variables:

```sh
python3 scripts/bigchange_kpi_report.py
```

## Daily workflow

`.github/workflows/aquilo-bigchange-kpi-overview-report.yml` runs **Aquilo BigChange KPI Overview Report** every day at `07:00 UTC` and can also be started manually with `workflow_dispatch`.

The workflow expects the BigChange, Freshdesk, SMTP, optional Freshdesk status ID, and optional staff alias values to be configured as repository secrets matching the environment variable names used by the script. It renders the dashboard with headless Chrome, emails the embedded PNG, uploads only `reports/bigchange-kpi-dashboard.png` as a workflow artifact, and commits the updated `automation-memory/kpi-baseline.json` snapshot for follow-up automations.

## BigChange TEMP Invoice Nominal Correction

Hourly automation entry point for correcting unsynchronised TEMP sales invoice line nominal codes:

```sh
python3 scripts/bigchange_temp_invoice_nominals.py
```

It reads `InvoicesWithoutSync`, processes only `SI` references beginning with `TEMP`, skips cancelled/deleted/rejected or non-invoice documents, updates the existing financial document by `DocId`, and prints only the scan/update/failure summary.

## Dandara appointment confirmations

The daily Dandara automation cross-checks open BigChange appointments over the next 15 days with FixFlo issues, requires an `IS########` reference and an awarded `JB` job, and posts the appointment confirmation to the tenant when their presence is requested or otherwise to the agent:

```sh
python3 scripts/dandara_appointment_confirmations.py
```

Supply `FIXFLO_API_KEY`, `FIXFLO_BASE_URL`, `BIGCHANGE_AUTH_MODE`, `BIGCHANGE_BASE_URL`, `BIGCHANGE_API_KEY`, `BIGCHANGE_USERNAME`, and `BIGCHANGE_PASSWORD` as environment variables. Credentials are never stored in the repository.

Each run writes `artifacts/dandara-confirmation-candidates.csv`, `artifacts/dandara-confirmation-results.json`, and `artifacts/dandara-confirmation-state.json`. The state and existing FixFlo comments prevent duplicate confirmations for the same issue and appointment date. Set `DRY_RUN=true` to perform all read and eligibility checks without posting comments or changing state.
