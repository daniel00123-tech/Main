# BigChange KPI Overview Automation

Daily automation that gathers BigChange legacy Web Services KPI data, renders a dark HTML dashboard to PNG, emails the PNG inline, and saves the run baseline to `automation-memory/kpi-baseline.json`.

Job KPIs are limited to jobs from the last 12 months. Current-month sales use quote and purchase-order financial documents from the first of the current month through the report date, attributed by the financial document `OrderCreator` web user. The calculation uses quote line `NetPrice` and purchase-order line `NetPrice` excluding `VatAmount`.

Run with the required BigChange and SMTP configuration supplied as environment variables:

```sh
python3 scripts/bigchange_kpi_report.py
```
