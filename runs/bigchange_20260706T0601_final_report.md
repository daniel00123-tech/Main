# BigChange automation final report

- Run window: 2026-06-06 06:16:34 UTC to 2026-07-06 06:16:34 UTC
- Total jobs reviewed: 5,840
- Total jobs successfully updated: 3
- Total successful update operations: 4
- Total jobs skipped/no further update required in final verification: 5,828
- Total jobs still failed/pending: 12

## Successful updates

- INT279416 / 192583938: set invoice status to InvoiceCreated.
- INT279417 / 192583957: marked actioned and set invoice status to InvoiceCreated.
- INT279418 / 192584131: set invoice status to InvoiceCreated.

## Category review

- Uncategorised category updates needed: 0
- All 5,840 reviewed jobs already had a valid existing category.
- Confirmed fallback category exists: Hayley Longford (132665).

## Final verification

- Remaining intended operations: 12
- Remaining operation type: auto_close_actioned only
- Remaining invoice-status updates: 0
- Remaining category updates: 0

## Remaining failures

BigChange rejected actioned updates for 12 unique jobs with:

`BigChange returned Code=2: Actioned flag can only be set on completed jobs`

Affected jobs:

- INT273388 / 190292622
- JOB273410~1 / 190429736
- COVER274778 / 190903404
- JOB277609 / 191738554
- DLFF278017 / 192073184
- PPM278287 / 192236607
- DLFF278601 / 192332967
- JOB278839 / 192504018
- INT279416 / 192583938
- INT279418 / 192584131
- JOB279636 / 192592473
- JOB279782 / 192628391

## Artifact index

- Initial preview: `runs/bigchange_20260706T0601_preview/`
- First apply: `runs/bigchange_20260706T0601_apply/`
- Intermediate verification: `runs/bigchange_20260706T0601_verify/`
- Retry apply: `runs/bigchange_20260706T0601_apply_retry/`
- Final verification: `runs/bigchange_20260706T0601_final_verify/`
