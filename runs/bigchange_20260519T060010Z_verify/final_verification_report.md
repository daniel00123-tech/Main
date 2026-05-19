# BigChange job automation final verification report

- Creation window: 2026-04-19 06:00:10 UTC through 2026-05-19 06:00:10 UTC
- Total jobs reviewed: 9998
- Previewed update operations before apply: 175
- Web-service update calls succeeded: 175
- Web-service update calls failed: 0
- Jobs fully satisfying requested Auto Close Down state after verification: 44
- Jobs with InvoiceCreated newly set by this run: 69
- Job category updates applied: 0
- Remaining jobs failed on Actioned=Yes verification: 131
- Total skipped/no update required after verification: 9823

## Initial preview state counts

- Actioned=No, InvoiceCreated=False: 25
- Actioned=No, InvoiceCreated=True: 106
- Actioned=Yes, InvoiceCreated=False: 44

## Remaining failure state counts

- Actioned=No, InvoiceCreated=True: 131

## Failure reason

- actioned_update_unavailable: 131 jobs remain Actioned=No. The supplied web-services API credentials accepted JobClientStatus updates, but JobSave/JobClientStatus actioned parameters and likely actioned endpoint names did not change the Actioned field. BigChange REST documents PATCH /v1/jobs/{jobId} with isActioned=true, but REST OAuth client credentials and Customer-Id were not supplied; attempts to use the provided API-key/basic credentials against REST returned unauthorized.

## Skip reasons after verification

- valid existing job category: 9515
- Auto Close Down flag not present: 8751
- Auto Close Down already actioned with InvoiceCreated status: 1116
- uncategorised but no matching category for creator: Stacey VB: 328
- uncategorised but no matching category for creator: Robert Kent: 114
- uncategorised but no matching category for creator: UDAP_Aston Place_ Manjit Matharu (Tech): 11
- uncategorised but no matching category for creator: Mitch Stage: 8
- uncategorised but no matching category for creator: Luis Legrove: 7
- uncategorised but no matching category for creator: FA - Vairavan -: 5
- uncategorised but no matching category for creator: Lucy Gibbons: 2
- uncategorised but no matching category for creator: GM - Christopher Stewart - DA1 2SD: 1
- uncategorised but no matching category for creator: Integration User: 1
- uncategorised but no matching category for creator: Jodie Rock (Urban Maintenance Group Ltd  ): 1
- uncategorised but no matching category for creator: Maria Rariza: 1
- uncategorised but no matching category for creator: Jason White: 1
- uncategorised but no matching category for creator: Stephanie Waitson: 1
- uncategorised but no matching category for creator: C-Jason White - DA3: 1
- uncategorised but no matching category for creator: GM - Stuart Williams - CO9: 1

## Artifact references

- Initial dry-run preview: runs/bigchange_20260519T060010Z_preview/preview_updates.json
- Apply report: runs/bigchange_20260519T060010Z_apply/summary_report.md
- Post-apply verification: runs/bigchange_20260519T060010Z_verify/summary_report.md
- Residual failures: runs/bigchange_20260519T060010Z_verify/residual_failures.json
