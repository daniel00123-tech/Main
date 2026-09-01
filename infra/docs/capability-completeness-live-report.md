# INFRA capability completeness + live hardening

Branch: `cursor/infra-capability-completeness-d3d8`  
PR compare: https://github.com/daniel00123-tech/Main/compare/cursor/infra-whatsapp-adversarial-100-d3d8...cursor/infra-capability-completeness-d3d8  
Date: 2026-09-01

## A. Production version before this pass

Live Worker was **not** `af0a2ccb`, `4e51f4de`, or `8c739a5b`.

`wrangler deployments list` at 19:55 UTC showed current 100% as:

| Time (UTC) | Version ID | Lineage |
|---|---|---|
| 19:23:29 | `4e51f4de-02ea-4317-b4a7-20299a258797` | Elvex Xero reads (`8dd2c6f`) |
| 19:36:49 | `ce3b73ac-…` | later overwrite |
| 19:46:37 | `94ee2124-…` | later overwrite |
| 19:54:14 | **`6617f4eb-be1d-4c89-b13e-0ce1f0566f11`** | `el-chatgpt-capability-b8da` tip `60e9284` |

Health had no lineage marker (`{"status":"ok","environment":"production"}` only). No new health versioning was invented.

`6617f4eb` was an **overwrite** of the d3d8 WhatsApp/quality/portal stack: it had ChatGPT OAuth/Outlook/Xero, but not portal chat, live-docqa persist, adversarial-100, or INFRA Elvex Xero EL-MCP routing.

## B. Combined lineage (true superset)

Built `cursor/infra-capability-completeness-d3d8` from:

1. `cursor/infra-elvex-xero-reads-d3d8` (`8dd2c6f`) — already on adversarial-100
2. merge `cursor/infra-portal-chat-v1-d3d8` (#423)
3. merge `cursor/infra-whatsapp-live-docqa-d3d8` (#422)
4. merge `cursor/el-chatgpt-capability-b8da` (#425, includes #419–#421)

Conflicts resolved as unions: Elvex role-gated Xero + ChatGPT tool overlay; live-docqa `retrieveDocumentChunks` + ChatGPT underspecified fallback; quality mobile tap targets kept; UK + named explicit dates; BUSINESS_SYSTEM skipped before knowledge search.

Also includes #409 reconcile → #410 quality v1.3 → #411 quality centre → #412 apply canary → #415 mobile buttons → #418 adversarial-100.

Later cherry-picked (without Director-force cron):

- `c410e14` knowledge fetch id/text/chunks + official `CF_VERSION_METADATA` on `/health`
- `7542194` Elvex search/fetch/catalogue via existing EL file tools (`search_elvex_files` / `get_elvex_file`)

Not merged: persist-William-as-Director, minute intended-role re-apply, migration `0050`. Those fight office_staff acceptance.

## C. Production Worker versions during this pass

| Step | Version |
|---|---|
| Combined tree first deploy | `90ea4149-4d77-4029-9238-aee2b8d79cc4` (20:05:19Z) |
| Catalogue `knowledge.read` fix | `ed9b18d7-a483-4ce8-b1df-e3dbde7bb2e6` (20:09:26Z) |
| Concurrent overwrites | `c39cffaa-…` (20:23), **`0e96a3d6-ca5c-469f-aa3c-88361f8ea36e`** (20:29:24Z) — superstack + Director-tools while remaining live ran |
| Completeness + EL file tools redeploy | **recorded after wrangler deploy in this commit cycle** |

Git tip after cherry-picks: see `git log -1` on `cursor/infra-capability-completeness-d3d8`.  
Web (portal chat UI): Pages `50b1abe4` / https://50b1abe4.infra-web.pages.dev  
`_redirects` unchanged: `/*    /index.html   200` only.

Deploy guard: `packages/api/scripts/assert-capability-completeness.mjs`. `npm run deploy` refuses if markers absent. `/health` now emits official Cloudflare `versionId` when `CF_VERSION_METADATA` is bound — not a new versioning architecture.

## D. William role

| When | Role |
|---|---|
| **Recorded before any change (first pass)** | **director** (`2026-09-01T20:03:43.404Z`) |
| Authorised Xero / info@ Outlook | director (already authorised — **no finance_team**) |
| First-pass finish | office_staff |
| Concurrent override | director (`cursor-director-override`, 20:12:41, “do not restore office_staff”) |
| **Recorded before remaining live** | **office_staff** (`2026-09-01 20:14:19`) |
| Temporary authorised for finance@ + Elvex Q&A | director (never finance_team, never platform-admin) |
| **Finish** | **office_staff** (`2026-09-01 20:33:26`) |

A concurrent superstack branch added a cron that re-applies Director if acceptance leaves office_staff. That code is **not** on this completeness tip. If William flips back to director after this report, that cron/agent is the cause.

Tester (`test@testing.com`, Caddington director) role unchanged.

## E. Xero tests 1–8 (director, EL MCP, no writes)

All via `https://api.infrastack.app/api/gateway/v1/mcp`. Source: `el-business-mcp`. Settlement: `zero_charge`.

| # | Call | Result |
|---|---|---|
| 1 | sales today `fromDate/toDate=2026-09-01` | 200, period applied, `totalSales=-114`, 1 txn |
| 2 | sales this month | 200, `2026-09-01`–`2026-09-01` |
| 3 | invoices today **structural dates** (not free-text “invoiced today 01/09/2026”) | 200, `INV-02245`, `dateFilterApplied` |
| 4 | outstanding unpaid YTD | 200, 40 invoices, first `INV-02244` |
| 5 | overdue | 200, 24 invoices |
| 6 | top customers this month | 200 |
| 7 | get invoice `INV-02244` | 200 |
| 8 | sales last month | 200, `2026-08-01`–`2026-08-31` |

## F. office_staff Xero denial

Prompt equivalent: “Tell me on Xero what our sales are” / `xero_sales_summary`.

- tools/call: `permission_denied`, `user_not_authorised`, `userRole=office_staff`, connected=true
- No Xero upstream after denial
- Usage: `success=0`, `settlement_status=denied`, no charge
- OAuth refresh tokens still valid after denial
- Completeness tree **hides** Xero reads from office_staff `tools/list` (`elvexRoleMaySeeXeroReadTools`)
- Live overwrite `0e96a3d6` advertised 34 Xero/plan tools to office_staff (Director-tools overlay). Completeness redeploy restores HIDE. Call denial still held on that overwrite.

## G. Invoice-by-date

Explicit `fromDate`/`toDate` wins. Period resolver accepts ISO and UK `01/09/2026`. Free-text is not forwarded as EL invoice search query (`resolveXeroReadArguments` + date filter on EL MCP).

## H–I. Document catalogue

Shared tool `list_company_documents` on ChatGPT / WhatsApp / Portal (system-meta).

- Sort: `newest`=`created_at`, `latest`=`modified_at`, `indexed` only if user asks what INFRA indexed
- Descriptions: summary → chunks → “Description unavailable from indexed content”
- Same visibility as search; no cross-tenant; no extra LLM
- Elvex also merges existing EL file-tool metadata when D1 `microsoft_knowledge_items` is empty

**Live Caddington (Tester director, MCP):**

- Newest by `created_at`: `CV 2015 1.1v.docx` (Google Drive, `2026-08-28 11:42:57`)
- Latest by `modified_at`: SharePoint `Invoice-DLEZINKG-0001.pdf` (`2026-08-27T14:59:13Z`)
- **orderDiffers=true** — metadata sort proven
- 10 + 10 rows

**Live Elvex catalogue** on remaining-live token: 401 `INFRA user credential has been revoked` after Q&A burned the access token. Not a permission error. Retry after redeploy.

Note: `created_at` on `microsoft_knowledge_items` is often INFRA insert time; `modified_at` is provider modified.

## J–K. Live document Q&A

#422 merged: `document_id` persist, short-follow-up enrichment, extractive fallback, `retrieveDocumentChunks`, adopt search after clarify. #425 ChatGPT `ask_document` + Outlook get retry also merged.

Transport: **MCP `search` + `ask_document`** (shared ChatGPT/Portal path). No unsolicited WhatsApp. Offline 99.2 is **not** live proof.

### Caddington — 20/20 sequences (live)

Search “staff handbook” → `gdrive-1jN8m8V5EcWvdaxeS7hk8RDW5KJPOT3oD` (`Commercial gas manager.pdf`, 5 hits). Alt “health and safety policy” → `VHL Q2. Health and Safety.docx`.

| Metric | Result |
|---|---|
| Sequences | 20 |
| Search empty | 0 |
| Direct answered | 20/20 |
| Short follow-up answered | 20/20 |
| `documentId` persisted | 20/20 (same search id) |
| NO_RESULTS / none with no answer | 0 |
| Usage | `ask_document` `knowledge.read` `success=1` `settled` |

Some directs reported `confidence=none` **with** an answer (extractive fallback). Not a CURRENT_DOCUMENT miss.

### Elvex — 20 sequences started (live)

Search “service agreement” via EL file tools on overwrite Worker: 8 hits, first `Application Form - 2026.docx` (`01MOJNBGJYWBJU6JVHBRFJY443UGLYFEI3`). Alt: `Health and Safety Policy (2).docx`.

| Sequences 1–3 | document_id persisted, answers present, `noneInDocument` true (preview/empty chunks class) |
| Sequences 4–20 | 401 credential revoked mid-run |

**NO_RESULTS classification (live):**

| Class | Seen? |
|---|---|
| A document_id never persisted | No (id from search reused on ask) |
| B short-follow-up filler ranking | Not proven live (answers returned) |
| C enrichment decayed on arrival | Not proven live on MCP path |
| D lastUserQuestion overwritten | N/A MCP `priorQuestion` passed |
| E Scout weaker / none with chunks | Elvex 1–3: answer + confidence none → extractive/none-in-document |
| F runGroundedQa not enriching | N/A MCP priorQuestion |
| G empty fetch / preview-only | **Likely Elvex 1–3** (`noneInDocument`) |
| H tenant / visibility empty corpus | Earlier office_staff “staff handbook” on D1-only path (before EL file tools) |
| I token revoked mid-batch | **Elvex 4–20** |
| J CURRENT_DOCUMENT path miss after hit | Not observed when token valid |

WhatsApp unsolicited messages: none. 9-turn persist-on-Meta not run (gated).

## L–N. Outlook

**List vs get id mismatch:** proven fixed.

info@ (first pass, director): list id `AAMkAGY1MTVlZjkx…AABQgcltAAA=` → get same id, `hasBody=true`.

**finance@ while authorised (director, remaining live):**

- `outlook_list_messages` → 13 messages, Graph id `AAMkADMxN2Q1MzRmLTQwNjItNDY3Yi05YmM3LTZjMDFmYTYzMGVhMA…AAAxEEoGAAA=`
- `outlook_get_message` used **that same id**
- Full body present (`hasBody=true`)

**finance@ while office_staff:** `permission_denied` (connected, role not allowed). No charge (`denied`). Then restored office_staff.

**Draft:** `REQUIRES_ACTION_ENGINE_EXTENSION`. Graph/EL MCP cannot create Draft without send on the current read path; Action Engine is Xero-scoped. Not implemented.

**Send:** not implemented. Next controlled-action feature.

## O. tools/list cleanup (director live list)

| Class | Tools |
|---|---|
| KEEP | `search`, `fetch`, `search_company_knowledge`, `get_knowledge_document`, `ask_document`, `list_company_documents`, `system_health`, `database_summary`, Outlook reads, Xero reads, `search_elvex_email`, `get_elvex_email`, automation read |
| MEDIATED_BY_HIGH_LEVEL_TOOL | `plan_xero_*`, `get/confirm/cancel/dry_run/execute_action_plan`, `list_pending_actions` — Action Engine, no redesign |
| HIDE | `send_elvex_email`, Outlook draft/send (already unadvertised); Xero reads for office_staff on completeness tree |
| RENAME_DESCRIPTION_ONLY | `search` / `database_summary` already say not for live Xero |

## P–Q. Channels

Same intelligence + gateway tools. Portal chat from #423 in this tree. WhatsApp webhook unchanged: `https://api.infrastack.app/api/webhooks/whatsapp` (GET without hub → 403 `Invalid verification request`). No unsolicited WhatsApp. Catalogue/Xero/Q&A available on WhatsApp via existing intelligence routing; gated live WhatsApp turns not sent.

## R–S. Result semantics + usage

- Xero authorised: `zero_charge`
- office_staff Xero: `denied`, no charge
- Catalogue Caddington: `knowledge.read`, success
- Caddington `ask_document`: `knowledge.read` `settled`
- Outlook info@ / finance@ authorised get: `zero_charge`
- Outlook finance@ office_staff: `denied`

## T. Regression

- Caddington M365 + Drive index used for catalogue and Q&A
- Elvex Xero reads via existing EL MCP (`credential_ref_id` null path)
- Elvex files via existing EL MCP file tools (no new Worker, no copied Drive creds)
- HT not mutated
- OAuth still valid after office_staff denial
- WhatsApp webhook URL unchanged
- No new Worker, no new LLM, Cursor not runtime
- Scout + 8B-fast only

## U. Performance

Catalogue is SQL + optional MCP activity / EL file metadata. No extra LLM for simple catalogue. Q&A uses existing Scout path only after a selected document.

## V. Deploy discipline

Identify live Worker → build combined tree → unit suite → deploy → record version → live acceptance → concurrent overwrite observed (`0e96a3d6`) → cherry-pick newer EL file-tool routing into completeness (not Director-force) → redeploy completeness → record **new** definitive version from wrangler.

## W–Y. Constraints held

- Webhook URL unchanged
- No secret rotation
- No Xero writes
- No email send
- No finance_team for remaining live (director already authorised)
- William finished `office_staff`
- Migrations 0025–0040 not replayed; 0039 OAuth not duplicated; 0049 portal chat not re-applied; 0050 not applied
- D1 `infra-control-plane` `adacb84d-7ee8-4b27-87ff-3d554b563d71`

## Z. PR

ManagePullRequest unavailable. Compare:

https://github.com/daniel00123-tech/Main/compare/cursor/infra-whatsapp-adversarial-100-d3d8...cursor/infra-capability-completeness-d3d8

## AA. Remaining gaps

1. Elvex 20-sequence batch incomplete (OAuth token revoked at seq 4). First 3 stayed on the selected Drive id.
2. WhatsApp gated 9-turn persist / REAL META not sent (no unsolicited WhatsApp)
3. Portal chat UI not browser-clicked (Pages deployed)
4. Concurrent agents may redeploy over this Worker or flip William to director
5. `created_at` on Microsoft items is often INFRA insert, not provider uploaded-at
6. Elvex `noneInDocument` on Application Form — preview/empty chunks (class G), not a missing CURRENT_DOCUMENT id

## AB. Pass standard

| Gate | Status |
|---|---|
| Real Xero reads | PASS |
| office_staff denial, no Xero, no knowledge fallback, no charge | PASS |
| Catalogue latest/newest from metadata | PASS (Caddington live MCP; newest ≠ latest) |
| Grounded descriptions | PASS (code + tests) |
| Q&A after search | PASS Caddington 20/20; Elvex 3/20 then 401 |
| Short follow-ups better | PASS Caddington 20/20 via `priorQuestion` |
| No auto-global fallback | PASS in tree (`globalSearchUsed` field present; scoped ask) |
| Outlook full get | PASS info@ and finance@, same list id |
| Draft honest extension | PASS `REQUIRES_ACTION_ENGINE_EXTENSION` |
| No send | PASS |
| No Caddington/Elvex/WhatsApp/OAuth regress | PASS on completeness tree |
| No secrets / no new Worker / shared capabilities | PASS |
| Known stable production version | **Redeploy recorded in follow-up commit after wrangler output** |

## AC–AE

Not verified in browser: portal chat UI clicks.  
Next controlled-action feature: Outlook draft/send behind Action Engine (not this pass).  
William must remain office_staff unless the operator separately wants Director.
