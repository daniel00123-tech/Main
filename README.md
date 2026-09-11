# Aquilo BigChange KPI Overview Report

Daily automation that gathers BigChange legacy Web Services KPI data and Freshdesk open-ticket data, renders a dark KPI dashboard to PNG, embeds and attaches the PNG in the report email, and saves the run baseline to `automation-memory/kpi-baseline.json`.

Job KPIs are grouped by BigChange job category staff owner and limited to jobs from the last 12 months. Current-month sales use invoice financial documents from the first of the current month through today. Sales are attributed to the latest linked job customer activity with client status `InvoiceCreated`, matching the creator back to the job category staff name. The calculation uses line `NetPrice - VatAmount` to report ex-VAT values and includes both synchronised and unsynchronised documents returned by `InvoicesWithItemsByPeriod`.

Freshdesk open tickets are fetched with pagination, spam/deleted tickets are ignored, owners are matched back to BigChange staff rows, and unmatched tickets are counted without creating orphan dashboard rows.

Run with the required BigChange, Freshdesk, and SMTP configuration supplied as environment variables:

```sh
python3 scripts/bigchange_kpi_report.py
```

## BigChange BTR Job Allocation (Test / Recommendation Mode)

Build-to-Rent job allocation automation for unscheduled Fixflo jobs. Runs in **recommendation-only mode** — no BigChange writes until an administrator explicitly approves live mode.

Test credentials and rules are stored in:

- `.env` — API credentials (gitignored; copy from `.env.example`)
- `automation-memory/bigchange-test-env.json` — test environment metadata (not live)
- `automation-memory/btr-allocation-rules.json` — site, role, and exclusion rules

```sh
cp .env.example .env
# Fill in test credentials, then:
python3 scripts/bigchange_btr_allocation.py
python3 scripts/bigchange_btr_allocation.py --list-candidates
python3 scripts/bigchange_btr_allocation.py --job-ref DLFF277975~1
```

Output is written to `reports/btr-candidate-allocation-test.md`.

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

## Elvex daily GR/ group job profit

Daily read-only report of GR/ groups invoiced yesterday (Europe/London). The email is the results table plus a short totals block — no method notes or job-id commentary above the table.

```sh
python3 scripts/elvex_daily_group_profit.py
```

Supply BigChange JobWatch credentials and Microsoft Graph `MS_TENANT_ID`, `MS_CLIENT_ID`, and `MS_CLIENT_SECRET` as environment variables. The script never writes to BigChange.

Each run writes `artifacts/dandara-confirmation-candidates.csv`, `artifacts/dandara-confirmation-results.json`, and `artifacts/dandara-confirmation-state.json`. The state and existing FixFlo comments prevent duplicate confirmations for the same issue and appointment date. Set `DRY_RUN=true` to perform all read and eligibility checks without posting comments or changing state.
