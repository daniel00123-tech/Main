# Main

## BigChange worksheet cleanup

This repository includes an hourly automation for rewriting BigChange worksheet works descriptions for jobs completed today only.

Required environment variables:

- `BIGCHANGE_AUTH_MODE=api_key`
- `BIGCHANGE_BASE_URL=https://webservice.bigchange.com/v01/services.ashx`
- `BIGCHANGE_API_KEY`
- `BIGCHANGE_USERNAME`
- `BIGCHANGE_PASSWORD`

Run manually:

```sh
python3 scripts/bigchange_worksheet_cleanup.py
```

The script reports only jobs scanned, worksheets updated, jobs skipped, and failures.
