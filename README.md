# BigChange KPI Overview Automation

Daily automation that gathers BigChange legacy Web Services KPI data, renders a dark HTML dashboard to PNG, emails the PNG inline, and saves the run baseline to `automation-memory/kpi-baseline.json`.

Run with the required BigChange and SMTP configuration supplied as environment variables:

```sh
python3 scripts/bigchange_kpi_report.py
```
