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

## C. New definitive production Worker

| Step | Version |
|---|---|
| Combined tree first deploy | `90ea4149-4d77-4029-9238-aee2b8d79cc4` (20:05:19Z) |
| Catalogue `knowledge.read` fix | **`ed9b18d7-a483-4ce8-b1df-e3dbde7bb2e6`** (20:09:26Z) **CURRENT 100%** |

Git tip at deploy: `4c727ff`.  
Web (portal chat UI): Pages `50b1abe4` / https://50b1abe4.infra-web.pages.dev  
`_redirects` unchanged: `/*    /index.html   200` only.

Deploy guard: `packages/api/scripts/assert-capability-completeness.mjs` (12 source markers). `npm run deploy` refuses if markers absent. Health still has no invented version field.

## D. William role

| When | Role |
|---|---|
| **Recorded before any change** | **director** (`2026-09-01T20:03:43.404Z`) |
| Authorised Xero / info@ Outlook | director (already authorised — **no finance_team**) |
| Denial + finish | **office_staff** |

No platform-admin elevation. Final D1 read: `office_staff`.

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

- tools/list: **no Xero tools**
- tools/call: `permission_denied`, `user_not_authorised`, `userRole=office_staff`, connected=true
- No Xero upstream call path after denial
- Usage: `success=0`, `settlement_status=denied`, no charge
- OAuth refresh tokens still valid after denial

## G. Invoice-by-date

Explicit `fromDate`/`toDate` wins. Period resolver accepts ISO and UK `01/09/2026`. Free-text is not forwarded as EL invoice search query (`resolveXeroReadArguments` + date filter on EL MCP).

## H–I. Document catalogue

Shared tool `list_company_documents` on ChatGPT / WhatsApp / Portal (system-meta).

- Sort: `newest`=`created_at`, `latest`=`modified_at`, `indexed` only if user asks what INFRA indexed
- Descriptions: summary → chunks → “Description unavailable from indexed content”
- Same visibility as search; no cross-tenant; no extra LLM

**Live Elvex (office_staff):** tool executes as `knowledge.read` (after fix). 0 file rows — Elvex has **no** `microsoft_knowledge_items`; MCP activity returned no Drive rows. Honest empty catalogue, not a permission error.

**Caddington metadata (same SQL the tool uses):**

- Newest by `created_at`: OneDrive remittance/legal set (`RemittanceAdvice_11737_47489_7897.pdf` first)
- Latest by `modified_at`: SharePoint `Invoice-DLEZINKG-0001.pdf` first — **different order**, proves metadata sort
- Counts: OneDrive 10, SharePoint 5, Outlook-shared 10 (Outlook excluded from file catalogue)

Note: `created_at` on `microsoft_knowledge_items` is INFRA insert time; `modified_at` is provider modified.

## J–K. Live document Q&A

#422 merged: `document_id` persist, short-follow-up enrichment, extractive fallback, `retrieveDocumentChunks`, adopt search after clarify.

#425 ChatGPT `ask_document` + Outlook get retry also merged.

**Live Elvex office_staff** `search` “staff handbook” returned no hits; `ask_document` not exercised on a live id. Offline 99.2 is **not** live proof. 20 sequences/tenant **not** completed this pass. WhatsApp unsolicited messages: none.

NO_RESULTS on Elvex search classified as empty corpus visibility for that query/role, not CURRENT_DOCUMENT path failure.

## L–N. Outlook

**List vs get id mismatch:** proven fixed while director.

- `outlook_list_messages` info@ returned Graph id `AAMkAGY1MTVlZjkx…AABQgcltAAA=`
- `outlook_get_message` used **that same id**
- Full body present (`hasBody=true`)

**finance@ while office_staff:** `permission_denied` — finance mailbox connected but role not allowed. No charge (`denied`).

**Draft:** `REQUIRES_ACTION_ENGINE_EXTENSION`. Graph/EL MCP cannot create Draft without send on the current read path; Action Engine is Xero-scoped. Not implemented.

**Send:** not implemented. Next controlled-action feature.

## O. tools/list cleanup (director live list)

| Class | Tools |
|---|---|
| KEEP | `search`, `fetch`, `search_company_knowledge`, `get_knowledge_document`, `ask_document`, `list_company_documents`, `system_health`, `database_summary`, Outlook reads, Xero reads, `search_elvex_email`, `get_elvex_email`, automation read |
| MEDIATED_BY_HIGH_LEVEL_TOOL | `plan_xero_*`, `get/confirm/cancel/dry_run/execute_action_plan`, `list_pending_actions` — Action Engine, no redesign |
| HIDE | `send_elvex_email`, Outlook draft/send (already unadvertised) |
| RENAME_DESCRIPTION_ONLY | `search` / `database_summary` already say not for live Xero |

office_staff list hides all Xero tools.

## P–Q. Channels

Same intelligence + gateway tools. Portal chat from #423 deployed in this tree. WhatsApp webhook unchanged: `https://api.infrastack.app/api/webhooks/whatsapp` (GET without hub → 403 `Invalid verification request`). No unsolicited WhatsApp. Catalogue/Xero/Q&A available on WhatsApp via existing intelligence routing; gated live WhatsApp turns not sent.

## R–S. Result semantics + usage

- Xero authorised: `zero_charge`
- office_staff Xero: `denied`, no charge
- Catalogue after fix: `knowledge.read`, `success=1` (Elvex empty list)
- Outlook info@ get: `zero_charge`
- Outlook finance@ office_staff: `denied`

## T. Regression

- Caddington M365 index still present (15 file items)
- Elvex Xero reads via existing EL MCP (`credential_ref_id` null path)
- HT not mutated
- OAuth still valid
- WhatsApp webhook URL unchanged
- No new Worker, no new LLM, Cursor not runtime
- Scout + 8B-fast only

## U. Performance

Catalogue is SQL + optional MCP activity. No extra LLM for simple catalogue.

## V. Deploy discipline

Identify live Worker → build combined tree → unit suite → deploy → record new version → live acceptance → catalogue permission fix → redeploy → record **`ed9b18d7`**.

## W–Y. Constraints held

- Webhook URL unchanged
- No secret rotation
- No Xero writes
- No email send
- No finance_team (director already authorised)
- William finished `office_staff`
- Migrations 0025–0040 not replayed; 0039 OAuth not duplicated; 0049 portal chat not re-applied
- D1 `infra-control-plane` `adacb84d-7ee8-4b27-87ff-3d554b563d71`

## Z. PR

ManagePullRequest unavailable. Compare:

https://github.com/daniel00123-tech/Main/compare/cursor/infra-whatsapp-adversarial-100-d3d8...cursor/infra-capability-completeness-d3d8

## AA. Remaining gaps

1. Elvex Drive/OneDrive catalogue empty in INFRA D1 — needs EL MCP metadata list, not semantic search
2. 20 live Q&A sequences per tenant not run
3. finance@ full get while authorised not re-run after restore (info@ get proven as director)
4. WhatsApp gated live catalogue/Xero/Q&A turns not sent (constraint: no unsolicited WhatsApp)
5. `created_at` on Microsoft items is INFRA insert, not always provider uploaded-at

## AB. Pass standard

| Gate | Status |
|---|---|
| Real Xero reads | PASS |
| office_staff denial, no Xero, no knowledge fallback, no charge | PASS |
| Catalogue latest/newest from metadata | PASS (Caddington SQL + shared tool; Elvex empty) |
| Grounded descriptions | PASS (code + tests) |
| Q&A after search | PARTIAL (code merged; live Elvex search empty) |
| Short follow-ups better | PASS in tree (#422+#425) |
| No auto-global fallback | PASS in tree |
| Outlook full get | PASS (info@, same list id) |
| Draft honest extension | PASS `REQUIRES_ACTION_ENGINE_EXTENSION` |
| No send | PASS |
| No Caddington/Elvex/WhatsApp/OAuth regress | PASS |
| No secrets / no new Worker / shared capabilities | PASS |
| Known stable production version | **`ed9b18d7-a483-4ce8-b1df-e3dbde7bb2e6`** |

## AC–AE

Not verified in browser: portal chat UI clicks (Pages deployed).  
Next controlled-action feature: Outlook draft/send behind Action Engine (not this pass).
