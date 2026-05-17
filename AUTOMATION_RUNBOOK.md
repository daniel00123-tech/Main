# Weekly report runbook

This is the short operational checklist for the weekly door-to-door timesheet
automation.

## Normal weekly run

1. Use branch `main` once the feature branch has been merged. Until merge, use
   `cursor/weekly-door-to-door-timesheets-eaa0`.
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
