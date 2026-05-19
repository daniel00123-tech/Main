# BigChange job automation consolidated summary

- Original preview run: 2026-05-19T06:41:34Z
- Final verification run: 2026-05-19T07:20:08Z
- Total jobs reviewed: 9998
- Total updated: 508 jobs (513 operations)
- Total skipped: 9383 jobs
- Total failed: 109 jobs (109 operations)
- Note: 2 jobs are counted in both updated and failed because one operation succeeded while their actioned update was rejected.

## Preview generated before changes

- Jobs with intended updates: 612
- auto_close_actioned: 132
- auto_close_invoice_created: 1
- job_category: 483
- Category target(s): Hayley Longford: 483

## Updates applied and verified

- auto_close_actioned: 26
- auto_close_invoice_created: 4
- job_category: 483

## Remaining failed updates after final verification

- auto_close_actioned: 109 (BigChange rejected these with: Actioned flag can only be set on completed jobs)

## Skip reasons from final verification

- valid existing job category: 9991
- Auto Close Down flag not present: 8747
- Auto Close Down already actioned with InvoiceCreated status: 1142
- uncategorised but no creator identified: status history did not include an owner: 7

## Artifacts

- Pre-change preview: runs/bigchange_20260519T_corrected_preview/preview_updates.json
- Pre-change review log: runs/bigchange_20260519T_corrected_preview/review_log.jsonl
- Apply log: runs/bigchange_20260519T_apply/apply_results.jsonl
- Final verification preview: runs/bigchange_20260519T_final_verify/preview_updates.json
- Final verification review log: runs/bigchange_20260519T_final_verify/review_log.jsonl
