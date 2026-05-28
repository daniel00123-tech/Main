# BigChange automation final report - 2026-05-28

- Creation-date window processed: 2026-04-28 06:05:07 to 2026-05-28 06:05:07 UTC
- Total jobs reviewed: 5577
- Confirmed Auto Close Down job tag ID: 239829
- Confirmed InvoiceCreated client status ID: 34
- Confirmed fallback category: Hayley Longford (ID 132665)

## Preview before updates

- Jobs with intended updates: 78
- Intended update operations: 139
  - auto_close_actioned: 78
  - auto_close_invoice_created: 61
- Job-category updates: 0

## Apply results

- Apply-time jobs with intended updates: 79
- Apply-time intended update operations: 141
  - auto_close_actioned: 79
  - auto_close_invoice_created: 62
- Successful update operations: 108
  - auto_close_actioned: 46
  - auto_close_invoice_created: 62
- Jobs with successful updates: 63
- Failed update operations: 33
- Jobs with failed updates: 33
- Skipped jobs: 5481

One additional job, LS268007 (187634914), had Auto Close Down confirmed at apply time even though it was not present in the initial dry-run preview; it was included in the apply-time preview and both intended operations succeeded.

## Post-apply verification

- Remaining intended update operations: 33
  - auto_close_actioned: 33
- Remaining invoice-status updates: 0
- Remaining job-category updates: 0

## Skip and failure reasons

- valid existing job category: 5577
- Auto Close Down flag not present: 4546
- Auto Close Down already actioned with InvoiceCreated status: 998 after apply
- Failure: BigChange returned Code=2: Actioned flag can only be set on completed jobs: 33

Detailed logs are in:

- `runs/bigchange_20260528T0601Z_preview/`
- `runs/bigchange_20260528T0601Z_apply/`
- `runs/bigchange_20260528T0601Z_post_apply_preview/`
