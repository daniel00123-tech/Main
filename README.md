# BigChange KPI Overview Automation

Daily automation that gathers BigChange legacy Web Services KPI data, renders a dark HTML dashboard to PNG, emails the PNG inline, and saves the run baseline to `automation-memory/kpi-baseline.json`.

Job KPIs are limited to jobs from the last 12 months. Current-month sales use invoice financial documents from the first of the current month through the report date, excluding cancelled, deleted, and rejected documents. Invoice sales are attributed to the latest `InvoiceCreated` (`JobClientStatusID = 34`) owner from `JobCustomerActivity` for the linked job, and each line is calculated as `NetPrice - VatAmount`.

Run with the required BigChange and SMTP configuration supplied as environment variables:

```sh
python3 scripts/bigchange_kpi_report.py
```
