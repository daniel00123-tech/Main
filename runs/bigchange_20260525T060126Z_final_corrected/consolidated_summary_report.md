# BigChange job automation consolidated summary

- Creation-date window: 2026-04-25 06:04:05 to 2026-05-25 06:04:05 UTC
- Total jobs reviewed: 5205
- Total updated: 1
- Total skipped: 5197
- Total failed: 7

## Successful updates

- Job category: 1
  - 188992098 / PPM271460: set category to `Jodie Thompson` from creator `Jodie Thompson`.

## Confirmed no further update needed

- Job categories: final validation found 5205 jobs with valid existing categories.
- Invoice status: final validation found the 7 remaining Auto Close Down jobs already had `InvoiceCreated`.

## Failed updates

- Auto Close Down mark actioned: 7
  - 188256320 / DLFF270072
  - 188445073 / DLFF270324
  - 188556960 / JOB270515
  - 188573141 / JOB270530
  - 188819801 / DLFF270292~1
  - 188859709 / EOT271295
  - 188873108 / DLM271315

Failure reason: no confirmed BigChange API endpoint was available for marking a job `Actioned`. The automation confirmed the Auto Close Down flag before listing these failures, and avoided further unconfirmed mutation.

## Artifact paths

- Initial dry-run preview: `runs/bigchange_20260525T060126Z_preview/`
- Initial apply responses: `runs/bigchange_20260525T060126Z_apply/`
- Corrected final validation/apply log: `runs/bigchange_20260525T060126Z_final_corrected/`
