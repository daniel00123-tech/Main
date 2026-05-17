# Weekly report runbook

This is the short operational checklist for the weekly door-to-door timesheet
automation.

## Normal weekly run

1. Use branch `main` once the feature branch has been merged. Until merge, use
   `cursor/weekly-door-to-door-timesheets-b589`.
2. Ensure the environment contains the variables from `.env.example`.
3. Install dependencies:

   ```bash
   python3 -m pip install --user -r requirements.txt
   ```

4. Run the report:

   ```bash
   python3 scripts/weekly_door_to_door_timesheets.py
   ```

5. Expected terminal summary:

   ```text
   Report period: YYYY-MM-DD to YYYY-MM-DD
   Engineers included: N
   Rows created: N
   Attention flags: N
   Email: sent
   Workbook: reports/door_to_door_timesheets_YYYY-MM-DD_to_YYYY-MM-DD.xlsx
   ```

## Quick validation without sending email

```bash
python3 scripts/weekly_door_to_door_timesheets.py --dry-run-email
```

Before sending a live report after any start/finish logic change, run:

```bash
python3 -m unittest discover -s tests
```

## Start/finish evidence rules

- Start times must come from actual evidence, not planned times.
- Use a tracking journey only when it is before a same-day actual job start.
- Use status ID 8 `On the way` only when it is before a same-day actual start
  for that same job.
- If the first job has no same-day status ID 10 `Started` or same-day
  `RealStart`, move through the day's jobs until a real start is found.
- If there is only `Accepted`/standalone `On the way` and no same-day real
  start, leave Start blank.
- Planned finish is only a fallback where the row has actual start/travel
  evidence. If Start is blank and there is no same-day completion, leave Finish
  blank too.
- Deduct time only when the actual travel/pre-start gap is longer than the
  reasonable distance allowance. If the journey is short/tight, unclear, or
  missing, do not deduct or add time.

Known regression check: `Saud Amjad / 2026-05-15 / AF29959` has only
`Accepted` and standalone `On the way` in BigChange, with no same-day actual
start/completion. A corrected report leaves both Start and Finish blank for
that row.

## Useful options

- `--today YYYY-MM-DD`: test the report period calculation for a specific run
  date.
- `--output-dir PATH`: write the workbook somewhere other than `reports/`.

## Troubleshooting

- If no jobs appear for a week, check whether the legacy `JobsList`
  `DateOptionId=0` call returned no rows. The script automatically falls back
  to `BIGCHANGE_JOBS_FALLBACK_DATE_OPTION_ID`, default `2`.
- If SMTP fails, verify SMTP environment variables only; do not print passwords.
- If a real engineer is missing, check whether they have any non-cancelled
  allocated job in the last 30 days and whether their resource is in one of the
  included resource groups.
