# BigChange Actioner

Python automation for marking safe completed BigChange / JobWatch jobs as actioned
through the legacy Web Services API.

The legacy endpoint is used:

```text
https://webservice.bigchange.com/v01/services.ashx
```

The tool scans `JobsList` with `Start` and `End` date parameters, then marks only
eligible jobs through `JobSaveBackOfficeNote`.

## Safety rules

Jobs are actioned only when all of the following are true:

- `Actioned` is blank, `No`, `false`, or `0`
- `Status` is exactly `Completed` or `Completed with issues`
- `StatusComment` is exactly `Complete` or `Completed`

Jobs with results such as `Completed Quote Required`, `Quote Required`,
`Further Time Needed`, `No Access`, or `Parts Required` are left unactioned.

## Configuration

Configuration can be supplied from the process environment, `.env`, `.env.local`,
or a file pointed to by `BIGCHANGE_ENV_FILE`. Environment variables override file
values. `.env.local` should not be relied on for automation because it is normally
git-ignored and local to one machine.

Required values:

```sh
BIGCHANGE_AUTH_MODE=api_key
BIGCHANGE_BASE_URL=https://webservice.bigchange.com/v01/services.ashx
BIGCHANGE_API_KEY=...
BIGCHANGE_USERNAME=...
BIGCHANGE_PASSWORD=...
```

Useful behavior settings:

```sh
BIGCHANGE_COMPLETED_STATUSES=Completed,Completed with issues
BIGCHANGE_STATUS_FIELD=Status
BIGCHANGE_ACTIONED_FIELD=Actioned
BIGCHANGE_ACTION_RESULT_FIELD=StatusComment
BIGCHANGE_ACTION_RESULT_VALUES=Complete,Completed
BIGCHANGE_LOOKBACK_DAYS=14
```

For automation, create a secret file outside the repository, then run:

```sh
BIGCHANGE_ENV_FILE=/tmp/bigchange.env python3 -m bigchange_actioner.cli --execute
```

Omit `--execute` for a dry run.

The command prints only a JSON summary:

```json
{
  "failures": 0,
  "jobs_actioned": 0,
  "jobs_scanned": 0,
  "remaining_actionable_jobs": 0
}
```

# Aquilo BigChange KPI Overview Report

Daily automation that gathers BigChange legacy Web Services KPI data and Freshdesk open-ticket data, renders a dark KPI dashboard to PNG, embeds and attaches the PNG in the report email, and saves the run baseline to `automation-memory/kpi-baseline.json`.

Job KPIs are grouped by BigChange job category staff owner and limited to jobs from the last 12 months. Current-month sales use invoice financial documents from the first of the current month through today. Sales are attributed to the latest linked job customer activity with client status `InvoiceCreated`, matching the creator back to the job category staff name. The calculation uses line `NetPrice - VatAmount` to report ex-VAT values and includes both synchronised and unsynchronised documents returned by `InvoicesWithItemsByPeriod`.

Freshdesk open tickets are fetched with pagination, spam/deleted tickets are ignored, owners are matched back to BigChange staff rows, and unmatched tickets are counted without creating orphan dashboard rows.

Run with the required BigChange, Freshdesk, and SMTP configuration supplied as environment variables:

```sh
python3 scripts/bigchange_kpi_report.py
```

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
