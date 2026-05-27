# BigChange job automation completion report

## Scope and confirmation

- Creation-date window: 2026-04-27 06:08:51 to 2026-05-27 06:08:51 UTC (last 30 days)
- Jobs reviewed: 5566
- Confirmed Auto Close Down tag ID: 239829
- Confirmed fallback category: Hayley Longford
- Confirmed InvoiceCreated status ID: 34

## Preview before changes

- Jobs with intended updates: 68
- Intended operations: 89
- auto_close_actioned: 26
- auto_close_invoice_created: 60
- job_category: 3

## Apply results

- Total jobs reviewed: 5566
- Total jobs updated (at least one successful operation): 63
- Total jobs skipped (no attempted operation): 5498
- Total jobs with failed operation: 18
- Operations updated: 71
- Operations failed: 18

Some jobs had both a successful invoice-status update and a failed actioned update, so the job-level updated/failed counts can overlap.

### Operations by type

- auto_close_actioned / failed: 18
- auto_close_actioned / updated: 8
- auto_close_invoice_created / updated: 60
- job_category / updated: 3

### Skip reasons

- valid existing job category: 5563
- Auto Close Down flag not present: 4565
- Auto Close Down already actioned with InvoiceCreated status: 936

### Failure reasons

- BigChange returned Code=2: Actioned flag can only be set on completed jobs: 18

### Failed jobs

- BigChange returned Code=2: Actioned flag can only be set on completed jobs
  - JOB267083 (187137561): auto_close_actioned
  - DLFF185174~5 (187302778): auto_close_actioned
  - INT269923 (188240210): auto_close_actioned
  - DLFF270176 (188348191): auto_close_actioned
  - DLFF270233 (188366306): auto_close_actioned
  - JOB270294 (188430037): auto_close_actioned
  - DLFF270322 (188444043): auto_close_actioned
  - JOB270570 (188608045): auto_close_actioned
  - JOB270572 (188608124): auto_close_actioned
  - DLFF271181 (188751418): auto_close_actioned
  - DLFF271182 (188751428): auto_close_actioned
  - JOB271185 (188751447): auto_close_actioned
  - DLFF271218 (188775160): auto_close_actioned
  - DLM271315 (188873108): auto_close_actioned
  - JOB271377 (188969813): auto_close_actioned
  - DLFF271497 (189004455): auto_close_actioned
  - JOB271514 (189006363): auto_close_actioned
  - DLFF271848 (189055800): auto_close_actioned

## Post-apply verification

- Remaining intended operations after apply: 18
- auto_close_actioned: 18

## Artifact paths

- Initial preview: `runs/bigchange_20260527T0601Z_preview`
- Apply run: `runs/bigchange_20260527T0601Z_apply`
- Post-apply verification preview: `runs/bigchange_20260527T0612Z_post_apply_preview`
