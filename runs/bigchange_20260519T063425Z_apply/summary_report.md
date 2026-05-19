# BigChange job automation summary

- Run started: 2026-05-19T06:53:13Z
- Run finished: 2026-05-19T07:37:15Z
- Mode: applied updates
- Total jobs reviewed: 9998
- Total jobs with intended updates in preview: 472
- Total updated: 344
- Total skipped: 9526
- Total failed: 132

## Intended update operations

- auto_close_actioned: 132
- job_category: 344

## Skip reasons

- valid existing job category: 9647
- Auto Close Down flag not present: 8750
- Auto Close Down already actioned with InvoiceCreated status: 1116
- uncategorised but no matching category for creator: status history did not include an owner: 7

## Failure reasons

- Marking Actioned requires BigChange REST PATCH /v1/jobs/{jobId} with isActioned=true; supplied web-services API credentials cannot authenticate to the REST API: 132
