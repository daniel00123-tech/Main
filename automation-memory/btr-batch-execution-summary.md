# BTR Batch Execution Summary

**Executed:** 2026-07-10 (UTC)

## Totals

| Category | Applied | Failed | Skipped |
|---|---:|---:|---:|
| Phase 1 — Incomplete reschedule | 7 | 0 | 0 |
| Phase 2 — High confidence | 9 | 0 | 0 |
| Phase 3 — Medium confidence | 19 | 0 | 0 |
| Phase 4 — Low confidence | 5 | 0 | 0 |
| **Total new allocations** | **40** | **0** | — |

Plus 1 repair re-apply (JOB278533 resource dropped during batch).

## Phase 1 — Incomplete non-PPM reschedules (7/7)

| Job ref | Resource | New date | Time |
|---|---|---|---|
| GRANQ247638 | Eric Wilson (Point Tech) | Mon 15 Jul | 14:10–15:10 |
| JOB282913 | Bradley Tice (Point Tech) | Mon 14 Jul | 12:00–13:00 |
| JOB282658 | Bradley Tice (Point Tech) | Mon 13 Jul | 12:00–13:00 |
| DLFF278603 | Charlie Lewtas (Chapel Tech) | Mon 13 Jul | 11:00–12:00 |
| JOB278609 | Charlie Lewtas (Chapel Tech) | Mon 13 Jul | 12:00–13:00 |
| JOB278174 | Charlie Lewtas (Chapel Tech) | Mon 13 Jul | 09:00–10:00 |
| JOB282501 | Charlie Lewtas (Chapel Tech) | Mon 13 Jul | 10:00–11:00 |

**Repair:** JOB278533 re-applied to Charlie Lewtas Mon 13 Jul 13:00–14:00 (resource had dropped during batch).

## Phases 2–4 — Unscheduled allocations (33/33)

All 33 ready-to-allocate jobs from the 30-day review were scheduled. See `btr-allocation-audit.jsonl` for full details.

### High confidence (9)
JOB277700~1, JOB277961, JOB278566~1, DLFF277704~1, DLFF277975~1, EOT284781~2, JOB284802, JOB284804, JOB284808

### Medium confidence (19)
JOB276484, JOB276884, DLFF275603~1, JOB279785, JOB279967, DLFF284758, DLFF284759, DLFF284760, JOB284765, JOB284791, DLFF284797, JOB284798, JOB284799, DLFF284800, JOB284803, JOB284805, DLFF284806, JOB279661~2, JOB284819

### Low confidence (5)
JOB277609~2, JOB278370~1, JOB273410~4, DLFF284810, DLFF284818

## Skipped (by design)

| Item | Reason |
|---|---|
| 4 contractor/Aquilo jobs | Contractor exclusion rules |
| JOB274501 (Baltic Yard) | No active Tech resource |
| 27 PPM stale diary jobs | Manual review only (Phase 5) |
| GRANQ174093 (sprinkler weekly) | Stale incomplete — manual |
| 7 previously actioned jobs | Already scheduled in earlier session |

## Notes

- Chapel Wharf unit-address jobs (Alcock House, Bradshaw House) required site override from review data when rescheduling via Job API.
- GRANQ247638 contact field reads "Forbes Place" but job belongs to The Point — scheduled to Eric Wilson per review data.
- Charlie Lewtas has 5 jobs on Mon 13 Jul (09:00–14:00) — monitor workload.
