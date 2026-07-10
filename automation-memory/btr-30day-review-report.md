# BTR Job Allocation — 30-Day Review Report

**Report date:** 10 July 2026  
**Lookback window:** 10 June 2026 – 10 July 2026 (30 days)  
**Mode:** Review only — **no changes have been made**

---

## Executive summary

| Pipeline | Count | Broad recommendation |
|---|---:|---|
| **Ready to allocate** (unscheduled, BTR, passes all rules) | **33** | Can be scheduled to site Tech/HK diaries — recommend batch review then allocate week commencing 14 July |
| **Reschedule candidates** (incomplete non-PPM on past diaries) | **7** | Move to next available slot within working hours (1 already done: JOB278533) |
| **Contractor / Aquilo excluded** (unscheduled) | **4** | Do not allocate to site staff — manual contractor route |
| **No suitable resource** (unscheduled) | **1** | Manual action — Baltic Yard has no active matching Tech |
| **Incomplete PPM on past diaries** | **27** | Review separately — many are routine checks; 15 are >7 days old and may need clearing |
| **Non-BTR unscheduled** (out of scope) | **72** | Ignored by this automation |

**Already actioned in testing (excluded from counts above where noted):**
- DLFF276866~1, JOB278036~3, EOT284781~1, JOB284807, JOB284790, DLFF284757 (allocated)
- JOB278533 (rescheduled)

---

## 1. Unscheduled jobs — created in last 30 days

**Total unallocated in window:** 109  
**BTR site jobs:** 37  
**Eligible after rules:** 33

### By category

| Category | Count | Action when approved |
|---|---:|---|
| Ready to allocate — Tech | 30 | Auto-schedule to site Tech/CT |
| Ready to allocate — HK | 3 | Auto-schedule to site HK |
| Contractor / Aquilo excluded | 4 | Exception report — do not allocate |
| No active resource (Baltic Yard) | 1 | Exception — assign resource or subcontract |
| Non-BTR / site unclear | 72 | Out of scope |

### Ready to allocate — by site

| Site | Count | Role mix | Confidence |
|---|---:|---|---|
| Leodis Square | 11 | Tech | Mix (incl. 5 Low) |
| The Point | 7 | Tech | Mostly Medium |
| Chapel Wharf | 7 | Tech | Mostly High/Medium |
| Granary Quay | 6 | Tech | High/Medium |
| U&A / Unity & Armouries | 2 | Tech | High |
| **Aston Place** | **0** | — | Only contractor-excluded PPM remains |
| **Baltic Yard** | **0** | — | JOB274501 blocked — no Tech resource |
| **Botanica** | **0** | — | No unscheduled BTR jobs in window |
| **Forbes Place** | **0** | — | No unscheduled BTR jobs in window |

### Confidence on ready jobs

| Confidence | Count | Note |
|---|---:|---|
| High | 9 | Suitable for first live batch |
| Medium | 19 | Review flags/target dates |
| Low | 5 | Manual review recommended before allocating |

### Contractor / Aquilo excluded (do not allocate)

| Job ref | Site | Type | Flag |
|---|---|---|---|
| JOB277904 | Aston Place | PPM - EM (Flick Test) & FA (Bell Test) | Sent to Aquilo |
| JOB272421~3 | Leodis Square | Building Call Out | BTR - Contractor Required |
| JOB280388~1 | Chapel Wharf | Building Call Out | BTR - Contractor Required |
| JOB282782 | The Point | Pest Control | Sent to Aquilo |

### No resource available

| Job ref | Site | Type | Issue |
|---|---|---|---|
| JOB274501 | Baltic Yard | Pest Control | No active site-based Tech/CT resource (28 days old) |

---

## 2. Historical incomplete jobs — planned in last 30 days, not completed

**Total incomplete on BTR Tech/HK/CT diaries:** 35  
(Planned dates 10 June – 9 July 2026, status not Completed/Cancelled)

### By site

| Site | Total incomplete | PPM | Non-PPM (reschedule candidates) |
|---|---:|---:|---:|
| Chapel Wharf | 13 | 9 | 4 |
| Leodis Square | 9 | 9 | 0 |
| The Point | 8 | 5 | 3 |
| Forbes Place | 3 | 3 | 0 |
| Granary Quay | 1 | 0 | 1 |
| U&A / Unity & Armouries | 1 | 1 | 0 |

### Non-PPM reschedule candidates (7 remaining)

| Job ref | Site | Resource | Was planned | Type | Status |
|---|---|---|---|---|---|
| GRANQ247638 | The Point | Eric Wilson | 9 Jul | BTR - Bins Out | Sent |
| JOB282913 | The Point | Bradley Tice | 9 Jul | Building Call Out | Sent |
| JOB282658 | The Point | Bradley Tice | 9 Jul | Building Call Out | Sent |
| DLFF278603 | Chapel Wharf | Charlie Lewtas | 9 Jul | EOT - End Of Tenancy Inspection | Sent |
| JOB278609 | Chapel Wharf | Charlie Lewtas | 9 Jul | Building Call Out | Sent |
| JOB278174 | Chapel Wharf | Charlie Lewtas | 9 Jul | Plumbing Call Out | Sent |
| JOB282501 | Chapel Wharf | Charlie Lewtas | 9 Jul | Electrical Call Out | Sent |
| ~~JOB278533~~ | ~~Chapel Wharf~~ | ~~Charlie Lewtas~~ | ~~9 Jul~~ | ~~Gas Boiler Call Out~~ | **Already rescheduled to 13 Jul** |

### Incomplete PPM on diaries (27 — review, not auto-reschedule)

Most are daily/weekly/monthly routine checks still showing as **Sent** on past dates. These are typically completed in the field but diary status may not have been updated.

**15 PPM jobs are >7 days old** on the diary — likely stale entries needing manual completion or reschedule.

---

## 3. Anomalies requiring your attention

| # | Anomaly | Count | Why it matters |
|---|---:|---|
| 1 | **Charlie Lewtas — 4 incomplete non-PPM jobs from 9 Jul alone** | 4 | Suggests workload overload or jobs not being closed — priority reschedule batch |
| 2 | **Incomplete jobs planned >14 days ago still Sent** | 11 | Very stale diary entries — may distort capacity planning |
| 3 | **GRANQ174093 — Sprinkler weekly test from 15 Jun still Sent** | 1 | 25 days overdue on Mark Taylor's diary |
| 4 | **Baltic Yard JOB274501 — 28 days unscheduled, no Tech resource** | 1 | Cannot automate until resource exists or job routed to contractor |
| 5 | **Leodis Square — 11 ready unscheduled but 9 incomplete PPM on diaries** | — | Diary may appear full; check if PPM Sent entries are blocking perception of capacity |
| 6 | **5 Low-confidence ready jobs (mostly Leodis Square)** | 5 | Site/role/duration uncertain — manual review before allocating |
| 7 | **Ready jobs with flags needing review** | 10 | Includes "Quote to be approved", "PO sent and awaiting date", "BTR - GM Feedback" |
| 8 | **Botanica & Forbes — zero unscheduled BTR jobs** | — | No action needed currently; monitor Fixflo feed |
| 9 | **72 non-BTR unallocated jobs in window** | 72 | Correctly excluded — confirm none are misclassified BTR |

### Stale PPM examples (>14 days incomplete)

| Job ref | Planned | Site | Type |
|---|---|---|---|
| GRANQ174093 | 15 Jun | Granary Quay | GRANQ - Sprinkler testing - Weekly BTR |
| DL260677 | 12 Jun | Chapel Wharf | PPM - Daily Internal Inspection BTR |
| PPM204567 | 15 Jun | Leodis Square | PPM - Leodis - Rotate Wheelie Bins |
| JOB274702 | 16 Jun | Leodis Square | PPM - EM (Flick Test) A |
| PPM276120 | 18 Jun | Chapel Wharf | PPM - Chapel - FA Testing - Chapman |

---

## 4. Suggested phased approach (when you give the command)

| Phase | Scope | Jobs | Action |
|---|---|---:|---|
| **Phase 1** | Reschedule incomplete non-PPM | 7 | Move to next available slot (same pattern as JOB278533) |
| **Phase 2** | Allocate ready High-confidence unscheduled | 9 | Schedule week of 14 July |
| **Phase 3** | Allocate ready Medium-confidence unscheduled | 19 | Schedule after flag review |
| **Phase 4** | Review Low-confidence + flagged | 5+ | Manual decision per job |
| **Phase 5** | PPM stale diary cleanup | 27 | Manual — complete or reschedule routine PPM entries |
| **Exception** | Contractor/Aquilo + Baltic Yard | 5 | Manual routing |

---

## 5. What this automation will NOT touch without explicit approval

- Jobs created before **10 June 2026**
- Non-BTR sites (72 jobs)
- Contractor/Aquilo-designated work (4 jobs)
- Heavy/specialist PPM without weekly/monthly check wording
- Any job where overlap, working hours, or resource active status fails validation

**No changes have been made to BigChange as part of this report.**
