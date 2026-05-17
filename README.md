# Weekly door-to-door engineer timesheet report

This repository contains a standalone Python automation for the weekly BigChange
door-to-door timesheet report.

The script:

- reads BigChange legacy Web Services credentials from environment variables;
- collects resources, groups, contacts, jobs, status history, and journeys;
- includes only engineers/subcontractors with active allocated jobs in the last
  30 days;
- creates an XLSX workbook with weekly, summary, and attention tabs;
- applies capped distance-based start-time deductions;
- highlights late completions that need checking; and
- emails the workbook via SMTP.

## Setup

```bash
python3 -m pip install -r requirements.txt
cp .env.example .env
```

Populate `.env` or export the environment variables listed in `.env.example`.
Do not commit real credentials.

## Run

```bash
set -a
. ./.env
set +a
python3 scripts/weekly_door_to_door_timesheets.py
```

The report period is the previous Monday to previous Friday relative to the run
date. Use `--today YYYY-MM-DD` to test a specific run date.

Generated workbooks are written to `reports/` and are ignored by git.

For future agents and scheduled runs, read `AGENTS.md` first and use
`AUTOMATION_RUNBOOK.md` for the short operational checklist.
