# BigChange consolidated completion report

- Creation window: 2026-04-18 06:00:50 UTC to 2026-05-18 06:00:50 UTC
- Source preview generated before changes: `runs/bigchange_20260518T060050Z_preview/preview_updates.json`
- Apply report: `runs/bigchange_20260518T060050Z_apply/summary_report.md`
- Residual reports: `runs/bigchange_20260518T060050Z_residual_apply/summary_report.md`, `runs/bigchange_20260518T060050Z_category_repair/summary_report.md`
- Terminal verification: `runs/bigchange_20260518T060050Z_terminal_verify/summary_report.md`

## Totals

- Total jobs reviewed: 9899
- Jobs with intended updates in the pre-change preview: 267
- Total candidate jobs observed across preview/apply/verification: 278
- Total updated (fully completed after verification): 168
- Total skipped/no confirmed update applied: 9621
- Total failed/incomplete after retries: 110

## Operation results

- Job category updates resolved: 165 of 165
- Auto Close Down jobs with Invoice Created status confirmed: 116 of 116
- Auto Close Down jobs fully completed, including Actioned=Yes: 6 of 116
- Auto Close Down jobs still not actioned: 110

## Failure reasons

- 110 Auto Close Down jobs remain with `Actioned=No`. The supplied web-service/api_key credentials successfully set/read `JobClientStatus=InvoiceCreated`, but no confirmed BigChange web-service action was available to set `Actioned=Yes`; the REST `isActioned` field is documented but requires OAuth client credentials and a customer-id, which were not supplied.

## Skip reasons from terminal verification

- valid existing job category: 9430
- Auto Close Down flag not present: 8714
- Auto Close Down already actioned with InvoiceCreated status: 1075
- uncategorised but no matching category for creator: Stacey VB: 320
- uncategorised but no matching category for creator: Robert Kent: 107
- uncategorised but no matching category for creator: Mitch Stage: 9
- uncategorised but no matching category for creator: UDAP_Aston Place_ Manjit Matharu (Tech): 9
- uncategorised but no matching category for creator: FA - Vairavan -: 6
- uncategorised but no matching category for creator: Luis Legrove: 6
- uncategorised but no matching category for creator: Lucy Gibbons: 2
- uncategorised but no matching category for creator: Integration User: 2
- uncategorised but no matching category for creator: C-Jason White - DA3: 2
- uncategorised but no matching category for creator: GM - Christopher Stewart - DA1 2SD: 1
- uncategorised but no matching category for creator: Jodie Rock (Urban Maintenance Group Ltd  ): 1
- uncategorised but no matching category for creator: Maria Rariza: 1
- uncategorised but no matching category for creator: Jason White: 1
- uncategorised but no matching category for creator: UDL_Leodis_Caretaker Gary Arundale: 1
- uncategorised but no matching category for creator: Stephanie Waitson: 1
