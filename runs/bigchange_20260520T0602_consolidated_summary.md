# BigChange 2026-05-20 consolidated summary

## Window

- Created from: 2026-04-20 06:02:12
- Created to: 2026-05-20 06:02:12
- Total jobs reviewed: 10095

## Final per-job outcome

- Total updated: 24
- Total skipped: 10063
- Total failed: 8

## Successful update operations

- Job category updates: 4
- Invoice status updates to InvoiceCreated: 28
- Actioned updates: 5 (includes one confirmed manual API probe logged in runs/bigchange_20260520T0602_manual_updates.jsonl)
- Total successful update operations: 37

## Failure reasons

- BigChange returned Code=2: Actioned flag can only be set on completed jobs: 8
  - JOB264154 (186208181)
  - JOB265015~1 (186614353)
  - JOB266584 (186906855)
  - DLFF252219~2 (186941931)
  - INT267455 (187244711)
  - GRANQ268171 (187655965)
  - DLFF266614~1 (187829074)
  - JOB270303 (188438505)

## Skip reasons

- Valid existing job category or category already corrected: 10095 in final verification
- Auto Close Down flag not present: 8801 in final verification
- Auto Close Down already actioned with InvoiceCreated status: 1286 in final verification

## Artifact index

- Initial preview: runs/bigchange_20260520T0602_preview/preview_updates.json
- Initial apply results: runs/bigchange_20260520T0602_apply/apply_results.json
- Remaining actioned preview: runs/bigchange_20260520T0602_actioned_preview/preview_updates.json
- Remaining actioned apply results: runs/bigchange_20260520T0602_actioned_apply/apply_results.json
- Final verification preview: runs/bigchange_20260520T0602_final_verify/preview_updates.json
- Manual actioned API probe log: runs/bigchange_20260520T0602_manual_updates.jsonl
