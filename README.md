# BigChange KPI Overview Automation

Daily automation that gathers BigChange legacy Web Services KPI data, renders a dark HTML dashboard to PNG, emails the PNG inline, and saves the run baseline to `automation-memory/kpi-baseline.json`.

Job KPIs are limited to jobs from the last 12 months. Current-month sales use invoice financial documents from the first of the current month through today. Each invoice is attributed through its linked job's latest `JobCustomerActivity` entry where `JobClientStatusID = 34` (`InvoiceCreated`). The calculation uses line `NetPrice - VatAmount` to report ex-VAT values.

Run with the required BigChange and SMTP configuration supplied as environment variables:

```sh
python3 scripts/bigchange_kpi_report.py
```
