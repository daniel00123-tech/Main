# BigChange May 21 final status

- Window reviewed: 2026-04-21 06:01:56 to 2026-05-21 06:01:56 UTC
- Total jobs reviewed: 10086
- Preview generated before changes: `runs/bigchange_20260521T060156Z_preview/`
- Primary apply report: `runs/bigchange_20260521T060156Z_apply/`
- Second apply report: `runs/bigchange_20260521T060156Z_apply2/`
- Final verification report: `runs/bigchange_20260521T060156Z_verify2/`

## Update results

- Job category updates completed: 351 operations
- Auto Close Down / InvoiceCreated operations accepted by the WebService: 98 operations
- Total WebService update operations accepted: 449
- WebService update failures: 0

## Final verification

- Total jobs with intended updates remaining: 21
- Remaining update type: `auto_close_invoice_created`
- Remaining reason: jobs have confirmed `Auto Close Down` flag and `InvoiceCreated` customer activity, but still show `Actioned=No`.

The WebService `JobClientStatus` action successfully added `InvoiceCreated` activity, but did not mark these jobs actioned. Additional `JobSave`, `JobUpdate`, and `JobClientStatus` actioned-field variants were tested against one already-previewed residual job and were either ignored or rejected by the WebService. BigChange REST documentation exposes `PATCH /v1/jobs/{jobId}` with `isActioned`, but the provided credentials are WebService credentials and did not authenticate against the REST OAuth token endpoint.

## Residual jobs

- 185931915 / DL259614
- 185933263 / DL259875
- 186208181 / JOB264154
- 186614353 / JOB265015~1
- 186624987 / JOB265875
- 186906855 / JOB266584
- 186941931 / DLFF252219~2
- 187244711 / INT267455
- 187655965 / GRANQ268171
- 188032913 / INT268815
- 188256431 / INT270073
- 188438505 / JOB270303
- 188481055 / JOB270132~1
- 188489547 / DLFF270352
- 188533985 / JOB270479
- 188544567 / DLFF270500
- 188545625 / DLFF270502
- 188546711 / DLFF270505
- 188588444 / JOB270547
- 188689991 / JOB271062
- 188712359 / JOB271074

