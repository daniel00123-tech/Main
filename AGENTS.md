# Agent context for weekly timesheet automation

Use this file first when a Cursor/Cloud agent is asked to run or adjust the
weekly door-to-door timesheet report.

## Branch

- Current feature branch: `cursor/weekly-door-to-door-timesheets-b589`
- Base branch: `cursor/weekly-door-to-door-timesheets-eaa0`
- Best branch for future scheduled runs:
  - Use `main` after this branch is merged.
 - Until then, use `cursor/weekly-door-to-door-timesheets-b589`.

## Fast path

Do not rediscover the BigChange API from scratch. The implementation is:

- `scripts/weekly_door_to_door_timesheets.py`
- `requirements.txt`
- Generated reports: `reports/*.xlsx` (ignored by git)

Run:

```bash
python3 -m pip install --user -r requirements.txt
python3 scripts/weekly_door_to_door_timesheets.py
```

For a no-email test:

```bash
python3 scripts/weekly_door_to_door_timesheets.py --dry-run-email
```

## Credentials

The script reads credentials from environment variables. Do not print, commit,
or email raw secrets. See `.env.example` for variable names.

## BigChange legacy Web Services notes

- Endpoint: `BIGCHANGE_BASE_URL`
- Auth mode: `BIGCHANGE_AUTH_MODE=api_key`
- Legacy calls use HTTP Basic auth with username/password plus query parameter
  `key=<BIGCHANGE_API_KEY>`.
- The report uses read-only actions only:
  - `JobsList`
  - `Resources`
  - `ResourceGroups`
  - `ContactList`
  - `ContactDetail`
  - `JobStatusHistory`
  - `Journeys`
- `JobsList` is called as requested with `DateOptionId=0`; if that returns no
  rows, the script falls back to `BIGCHANGE_JOBS_FALLBACK_DATE_OPTION_ID` which
  defaults to `2` because the legacy API returned planned allocations there in
  live testing.

## Current report behavior

- Report period: most recent completed Monday-Friday before the run date.
- Include only resources in groups `1. Engineer` and `2. Subcontractor`.
- Exclude explicit phantom diaries and any `z.` diary.
- Exclude engineers/subcontractors with no active allocated jobs in the last
  30 days.
- Active jobs currently means allocated jobs with a resource and a status that
  does not contain `cancel`.
- Each included engineer gets exactly five rows for the report week.
- Start times must be based on actual evidence only:
  - First use a same-day tracking journey only when it is before a same-day
    actual job start.
  - Otherwise use status ID 8 `On the way` only when it is before a same-day
    actual job start for that same job.
  - Otherwise use the first same-day status ID 10 `Started` or same-day
    `RealStart`, scanning through the day's jobs until one is found.
  - Never fall back to planned start for the Start column.
  - Never use a standalone `On the way`/`Accepted` without same-day actual
    start evidence; leave Start blank in that situation.
- Finish times use same-day completion where present. Planned finish is only a
  fallback when the row has actual start/travel evidence; do not show planned
  finish while Start is blank.
- Deduction logic only shortens days when the recorded journey/pre-start gap is
  longer than the distance-based allowance. Do not add time or deduct when the
  journey looks too short, unclear, or missing.
- SMTP sends the XLSX to `SMTP_TO_EMAIL`.

## Cost-control guidance

For routine weekly runs, avoid web searches and broad codebase exploration.
Read this file, inspect `scripts/weekly_door_to_door_timesheets.py` only if
needed, install requirements, and run the script.
