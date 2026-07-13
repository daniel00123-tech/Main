# COVER272900 Follow-up — 2026-07-13

## Finding

`COVER272900` is assigned in BigChange TEST to `UDA_Forbes_Tech-Bailey Middleton` on 2026-07-13 09:00-10:00.

BigChange `ResourceAbsences` for resource `442814` includes duplicate `Annual Leave` entries covering 2026-07-09 00:00 through 2026-07-15 23:59, so the 13 July booking conflicts with Bailey Middleton's annual leave.

## Audit status

`COVER272900` is not present in `automation-memory/btr-allocation-audit.jsonl`; it was not changed by the 2026-07-10 daily allocation run. The job was already planned in BigChange and was discovered by direct API inspection after the user reported the leave conflict.

## Automation change

The allocation helpers now query `ResourceAbsences` and add absence blocks to slot finding and post-schedule verification. The daily runner also treats `COVER*` / `Agency Cover` jobs as manual rota-review items rather than normal BTR maintenance allocations.

No BigChange write was made for `COVER272900` during this follow-up.
