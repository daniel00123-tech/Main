# BigChange TEMP invoice VAT correction

Cursor Agents should run the existing implementation:

```bash
./run_bigchange_temp_vat_fix.sh
```

Do not spend time searching for a missing integration. The implementation is in
`scripts/bigchange_temp_vat_fix.py`.

The required credentials are provided by the automation trigger context or the
environment. Do not print credential values.

Expected report fields:

- TEMP invoices scanned
- invoices skipped
- invoices corrected
- lines corrected
- invoices converted by BigChange from TEMP to INV
- failures
