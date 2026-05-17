# BigChange KPI Overview Automation

Daily automation that gathers BigChange legacy Web Services KPI data, renders a dark HTML dashboard to PNG, emails the PNG inline, and saves the run baseline to `automation-memory/kpi-baseline.json`.

Job KPIs are limited to jobs from the last 12 months. Current-month sales use invoice and credit-note financial documents from the first through the last day of the current month. Sales are attributed to the closest linked job customer activity with client status `InvoiceCreated`, matching the "Document creator" shown on the BigChange financial document report. The calculation uses line `NetPrice - VatAmount` to report ex-VAT values and includes both synchronised and unsynchronised documents returned by `InvoicesWithItemsByPeriod`.

Run with the required BigChange and SMTP configuration supplied as environment variables:

```sh
python3 scripts/bigchange_kpi_report.py
```
