# Caddington Phase 1 Operational UAT

**Date:** 2026-08-29  
**Overall classification:** **PASS WITH LIMITATIONS**

No production-breaking customer-path failure was found that required a code change, deploy, or migration. Live ChatGPT-equivalent MCP paths for identity, catalogue, knowledge, Xero read, write governance, automation control, isolation, metering, and audit were exercised against production. Interactive portal login was **BLOCKED** (no customer credentials in this environment). No extra customer emails, financial writes, or leftover active automations were left behind.

This is a UAT stop. No further feature sprint follows.

---

## Production identity (inventory)

| Item | Production evidence |
| --- | --- |
| Company | `co_caddington` / `caddington-holdings` / Caddington Holdings / `Europe/London` / `active` |
| Cross-tenants | HT `co_ht` / `ht-business`; EL `co_el` / `el-business`; both `active`, connectors **draft / not_configured** |
| Live ChatGPT identity | `svc_c574f59b-d8eb-493e-917b-ee4c223e37f1` **active**, `mcp_caddington_primary`, 336 requests, last used `2026-08-28T21:24:52.398Z`. **Not rotated.** |
| Claude identity | `svc_66a0f197-bfb1-43c9-bc0f-1e090f5233f1` active, unused |
| MCP environment | `mcp_caddington_primary` healthy; last successful request `2026-08-28T22:08:41.734Z` |
| Google Drive | `ci_caddington_gdrive` healthy / connected |
| Microsoft 365 | `ci_ms365_1787853087434` health `healthy`, auth connected; last health `2026-08-28T20:44:44.248Z` |
| Microsoft sources (29 Aug 06:45 UTC) | OneDrive Daniel Dwyer **included/healthy**; SharePoint Communication site Documents **included/healthy**; Outlook shared Admin **included/healthy** |
| Xero | `ci_67a8b408-25ed-49c3-8289-fb31a08ceb6e` healthy / connected; last health `2026-08-28T23:11:37.260Z` |
| Email | `admin@CaddingtonHoldings.co.uk`, allowed types include `XERO_SALES_REPORT` + `DOCUMENT_ACTIVITY_REPORT`, health `healthy`, last sent `2026-08-28T23:25:48.819Z` |
| Wallet | Before UAT £29.05 (`2905` pence); after UAT £29.00 (`2900` pence) |
| Users | Platform admin `daniel.dwyer123@gmail.com` (company_admin on Caddington/HT/EL); Caddington directors `morghan@morghan.com`, `test@testing.com` |

Production customer automations left **active** (unchanged):

| Automation | Id | Schedule | Last accepted run |
| --- | --- | --- | --- |
| Daily month-to-date sales | `aut_4aaad1ae-8494-40ea-b606-75aab871db58` | Daily 08:00 Europe/London, next `2026-08-29T07:00:00.000Z` | `aur_2527293d-435a-496c-bba8-d0de608cc6f9` — £8,277.48, 11 invoices, 1–29 Aug 2026, email `email_6fb72ca3-0935-4254-9c8e-578042d4b36b` sent |
| Daily document activity | `aut_df4dcc96-2a1a-418f-8285-aafa134b3f99` | Daily 12:00 Europe/London, next `2026-08-29T11:00:00.000Z` | `aur_5dfcee58-d930-48db-96af-b2fdbbeb872c` — Drive 711, OneDrive 9, SharePoint 4, Outlook attachments present; email `email_67bdb6e2-f085-4f0c-bc95-ca0114278b09` sent |

---

## Production UAT matrix

Verdicts are from **this** production exercise. Unit tests alone were not treated as PASS.

| # | Area | Verdict | How exercised |
| --- | --- | --- | --- |
| 1 | Company / tenant identity and isolation | **PASS** | Live D1 company rows; Caddington MCP token rejected `companyId=co_ht` and `co_el` with HTTP 403 `Service identity does not belong to this company` |
| 2 | ChatGPT → INFRA MCP auth and catalogue | **PASS** | Unauthenticated 401; invalid token 401; initialize `2025-03-26` / `infra-gateway`; `tools/list` 54 tools including knowledge, Xero read, Action Engine plans, all 10 automation tools; **zero** direct Xero write tools |
| 3 | Google Drive search / retrieval | **PASS** | Live `search_company_knowledge` returned `google_drive` hits (contract PDFs). `fetch` returned 445 characters for id `1` |
| 4 | Microsoft 365 / OneDrive / SharePoint / Outlook knowledge | **PASS** | Live search returned `microsoft_365` hits; targeted “LLP Agreement - signed.pdf” (OneDrive) and “Coal Search.pdf” (SharePoint). Outlook mailbox titles `889` / `123` / `Test1` / `67567` appeared in general search and exist as `outlook_shared` in D1. Sources healthy at 06:45 UTC |
| 5 | Xero read + canonical financial calculations | **PASS** | Live `xero_get_organisation` → **Caddington Holdings Ltd**; live `xero_sales_summary` and `xero_profit_and_loss` for 2026-08-01–2026-08-29 succeeded. Canonical ACCREC-net-of-ACCRECCREDIT total from accepted production run: **£8,277.48 / 11 invoices** |
| 6 | Xero write governance and confirmation | **PASS** | Direct `xero_create_draft_invoice` denied (`insufficient_permissions` / Action Engine required; audit `permission.denied`). `plan_xero_draft_invoice` created `act_ff84fed5-…` and did **not** execute. `execute_action_plan` without confirm → `PLAN_NOT_EXECUTABLE`. Plan cancelled |
| 7 | Outbound transactional email | **PASS** | No new email sent this UAT. Existing production sends from Caddington sender succeeded (sales, document activity, password resets to Morghan). See limitations for one earlier invitation failure |
| 8 | Existing sales automation | **PASS** | MCP `automation_get` shows active 08:00 London; last run and next run match D1; accepted run + sent email above. **Not** re-run |
| 9 | Existing document-activity automation | **PASS** | MCP `automation_get` shows active 12:00 London; accepted run + sent email above. **Not** re-run |
| 10 | NL automation list/get/plan/create/update/pause/resume/delete | **PASS** | Live MCP on ChatGPT-equivalent identity. Controlled probe `aut_fc135e01-…` created, paused, updated 05:17→05:19, resumed, archived. Production automations untouched |
| 11 | Automation duplicate protection | **PASS** | Plan of identical 08:00 sales returned `summary.duplicate` naming `aut_4aaad1ae-…`. Confirmed create → `DUPLICATE_AUTOMATION`. Nothing created |
| 12 | Portal representation of ChatGPT-created automations | **PASS** (data path) / **BLOCKED** (interactive UI) | Probe stored `createdVia=chatgpt`; portal API serialises `createdVia`. Management URL `https://infra-web.pages.dev/portal/caddington-holdings/automations`. Unauthenticated list API 401. Login not available here |
| 13 | Usage / metering | **PASS** | This UAT wrote usage rows and 5 × `usage_debit` of −1 pence (`ledger_b159ed9f-…` … `ledger_e7a900d0-…`). Wallet 2905 → 2900 pence. `system.health` billed `false` |
| 14 | Audit trail | **PASS** | Facade auth denials, `company.accessed`, `mcp.execution_*`, `billing.credit_adjusted`, `permission.denied` on direct Xero write, `automation.planned/created/paused/updated/resumed/archived` for the probe |
| 15 | Billing / wallet | **PASS** (ledger) / **BLOCKED** (interactive billing UI) | Wallet isolated: Caddington 2900p; HT/EL 1000p promotional only, unused this window. Portal wallet API 401 without session. Stripe live configured on public health |
| 16 | Customer health / Attention | **PASS** (signals) / **BLOCKED** (interactive Attention UI) | Gateway health `ok`; MCP `system_health` `healthy`; connectors healthy; ops heartbeats `automation_scheduler` and `microsoft_scheduler` success `2026-08-29T06:45:49Z`. Company attention API 401 without session |
| 17 | Permissions / RBAC | **PASS** (service + API) / **BLOCKED** (interactive role UI) | Service token cannot spoof tenant. Portal automations/wallet require auth (401). D1 roles: platform admin + two Caddington directors. Staff/manager interactive denial **NOT TESTED** |
| 18 | Cross-tenant negatives vs HT and EL | **PASS** | HT/EL connectors remain draft. Caddington token + `companyId=co_ht` / `co_el` → 403. No HT/EL automations, knowledge, or Xero data returned |
| 19 | Production reliability / health | **PASS** | Public `GET /api/gateway/v1/health` 200, Stripe live, MCP facade advertised. Schedulers succeeded this morning. No UAT-caused incidents |
| 20 | Mobile and desktop customer portal regression | **PASS** (public + CSS) / **BLOCKED** (authenticated click-through) | `https://infra-web.pages.dev` and portal routes 200 SPA. Deployed CSS `index-bvGhwvRk.css` still contains mobile topbar, 2-column marketplace stats, and `@media (max-width: 720px) { .scope-banner { display: none } }`. Authenticated flows not logged in |

### Explicitly NOT TESTED / BLOCKED

| Item | Verdict | Reason |
| --- | --- | --- |
| `automation_run_now` this session | **NOT TESTED** | Would send another real email. Prior production Run now evidence retained |
| Interactive portal login / automations / billing / Attention / RBAC UI | **BLOCKED** | No customer portal credentials in this environment |
| Live customer ChatGPT token (not a probe) | **NOT TESTED** | Must not rotate or use `svc_c574f59b`. Equivalent `chatgpt` identity + **identical live scopes** used instead |
| `xero_connection_test` tool name | **NOT TESTED** | Not in the customer catalogue. Xero health proven by live reads + connector row |
| New USER_INVITATION / extra transactional email | **NOT TESTED** | Avoid unnecessary customer email |
| HT / EL as connected customers | **NOT TESTED** | They are not connected; negative isolation was the required test |

---

## Every test performed

UAT identity: `svc_uat_p1_1787986293249` (`TEMP Phase 1 Operational UAT`), type `chatgpt`, scopes **copied from live Caddington ChatGPT** (no `automation.read` / `automation.manage`). Disabled after the run.

Follow-up identity: `svc_uat_p1b_1787986399499`, disabled after the run.

| Test | Result | Evidence |
| --- | --- | --- |
| MCP no auth | 401 | audit `permission.denied` 06:51:34Z |
| MCP bad token | 401 | “Invalid or revoked service token” |
| initialize | 200 | protocol `2025-03-26`, server `infra-gateway` |
| tools/list | 200 | 54 tools; 10 automation tools present; no `xero_create_*` / approve / send |
| system_health | 200 | `status: healthy`; usage recorded, not billed |
| search “Caddington” | 200 | 5 hits: 4 `microsoft_365`, 1 unknown |
| search “invoice contract policy” | 200 | 5 `google_drive` hits |
| search “SharePoint OneDrive Outlook” | 200 | mix of `google_drive` + `microsoft_365` |
| standard `search` | 200 | same pattern as company knowledge search |
| `fetch` id `1` | 200 | title present, 445 content chars (body not logged) |
| search “Bare Trust Declaration signed” | 200 | `LLP Agreement - signed.pdf` as `microsoft_365` (OneDrive title in D1) |
| search “Coal Search SharePoint” | 200 | `Coal Search.pdf` as `microsoft_365` (SharePoint title in D1) |
| xero_get_organisation | 200 | Caddington Holdings Ltd |
| xero_sales_summary 1–29 Aug 2026 | 200 | GBP + summary/transactions payload |
| xero_profit_and_loss 1–29 Aug 2026 | 200 | same org + date range |
| xero_create_draft_invoice | denied | `insufficient_permissions`; audit `permission.denied` 06:51:49Z |
| plan_xero_draft_invoice | planned, not executed | `act_ff84fed5-1bd4-415b-a509-992cc908d3db` |
| execute_action_plan without confirm | blocked | `PLAN_NOT_EXECUTABLE` |
| cancel_action_plan | cancelled | status `cancelled` |
| automation_list | 200 | 4 visible (2 customer active + 2 paused engine tests); URL portal automations |
| automation_get sales/docs | 200 | ids, schedules, recipients, next/last run |
| automation_plan identical sales | 200 | `apl_0bbfa466-…`; `duplicate.id=aut_4aaad1ae-…`; `created=false` |
| automation_create without confirm | `CONFIRMATION_REQUIRED` | not created |
| automation_create confirmed duplicate | `DUPLICATE_AUTOMATION` | not created |
| HT / EL companyId spoof | 403 | isolation message above |
| Probe plan/create/pause/update/resume/delete | 200 | `aut_fc135e01-…` now `disabled` + `archived=true` |
| Portal automations/wallet unauthenticated | 401 | customer APIs gated |
| Public gateway health | 200 | `stripeMode: live`, `mcpFacade: /api/gateway/v1/mcp` |

Raw MCP evidence file (no tokens, no document bodies): `/tmp/caddington-phase1-uat-evidence.json`.

---

## Genuine production evidence (selected)

- Gateway: `https://infra-api.daniel-dwyer123.workers.dev/api/gateway/v1/health` → `{"status":"ok","service":"infra-gateway","version":"v1","stripeConfigured":true,"stripeMode":"live","stripePaymentsAllowed":true,"mcpFacade":"/api/gateway/v1/mcp"}`
- Portal: `https://infra-web.pages.dev` and `/portal/caddington-holdings/automations` return the INFRA SPA (200)
- Isolation: HTTP 403 `Service identity does not belong to this company` for `co_ht` and `co_el`
- Duplicate: “You already have 'Daily month-to-date sales' running at 08:00.”
- Wallet movement this UAT: five 1-pence usage debits, balance `2905` → `2900`
- Probe cleanup: `aut_fc135e01-b7cd-495b-b314-89627c33ab40` `createdVia=chatgpt`, `archivedAt=2026-08-29T06:51:52.983Z`
- No `email_outbox` rows created after `2026-08-29T06:50:00`
- Active automations after UAT: only the two production customer automations

---

## Failures discovered

**None that require a production code fix.**

Observations that are **not** treated as UAT FAIL:

1. **`xero_connection_test` is not in the ChatGPT catalogue.** Customer Xero health is covered by live organisation/sales/P&L plus connector `healthy`.
2. **Live ChatGPT identity scopes omit `automation.read` / `automation.manage`.** Catalogue and execution still allow ChatGPT identities to control automations (identity type, not those scopes). The UAT identity used the **same scopes as live ChatGPT** and the 10 tools still appeared and worked.
3. **System-created production automations have `createdVia=null`.** They were created by `system:automation-creation-v1`, not ChatGPT. ChatGPT-created rows do store `createdVia=chatgpt`.
4. **Historical `USER_INVITATION` to `test@testing.com`** (`email_bf4962b2-…`, 2026-08-28T21:18Z) failed with `Mail.Send permission or Exchange sender scope required.` Later the same sender successfully sent password resets and both automation reports. Not re-tested (would send another email).
5. **Two pre-V1 queued outbox rows** remain (`email_821ea330-…`, `email_e9f91b10-…`) with null type. Not customer-facing current path.
6. **Google Drive `last_successful_sync_at` is null** on the connector row; live Drive search still returned current indexed files.

---

## Fixes made

**None.** No production code change, no deploy, no D1 schema migration.

Operational cleanup only (not product changes):

- Disabled leftover probe identities: `svc_probe_bdf5c09aa36f3b89`, `svc_write_alpha_ff25a34f`, `svc_write_alpha_9016f77e`, `svc_22ea400e-8afc-443f-9ac3-4a6e047f7aa3`
- Disabled UAT identities `svc_uat_p1_1787986293249` and `svc_uat_p1b_1787986399499`
- Archived UAT probe automation `aut_fc135e01-…`
- Did **not** disable live ChatGPT, Claude, or the two production automation identities

---

## Regressions checked

- Production sales + document automations still **active**, same schedules, same recipient
- No new outbound email during UAT
- No Xero invoice/contact written (plan cancelled; direct write denied)
- HT/EL still unconnected drafts
- Live ChatGPT identity still **active** and unrotated
- Portal public shell and mobile CSS from the last portal deploy still present
- Wallet only moved by metered UAT reads (5 pence)

---

## Tenant-isolation evidence

- Caddington token is bound to `co_caddington` / `mcp_caddington_primary`
- Spoof `companyId=co_ht` on `automation_list` → 403
- Spoof `companyId=co_el` on `search_company_knowledge` → 403
- HT/EL have no connected Drive/Microsoft/Xero and no Caddington automations
- HT/EL wallets unchanged (1000 pence promotional each)
- Knowledge and Xero payloads named **Caddington Holdings Ltd** only

---

## Security / governance evidence

- MCP requires a valid `infra_` service token
- Direct Xero write tools are **absent** from `tools/list` and **denied** on `tools/call`
- Financial writes require Action Engine plan → confirm → execute; unconfirmed execute blocked
- Automation create requires `planId` + `confirmationToken` + `confirmed=true`
- Duplicate fingerprint (template + daily 08:00 London + same recipient) blocks a second sales automation
- Portal company APIs return 401 without a session
- Destructive UAT probe archived; leftover unused probe tokens disabled

---

## Remaining limitations

- Interactive customer portal (login, automations UI, billing UI, Attention UI, mobile click-through) not exercised — **BLOCKED**
- `automation_run_now` not re-fired this session (email avoidance)
- Live ChatGPT scopes are older than `BASE_AI_SERVICE_SCOPES` (missing automation scopes); current gateway still serves those tools to `chatgpt` identities
- Outlook attachment search ranking is mixed; Outlook knowledge is indexed and some mailbox titles are searchable, but a filename query did not always rank the Outlook PDF first
- One historical invitation send failed; later transactional mail succeeded
- Google Drive connector row does not record `last_successful_sync_at` even though search works
- Paused engine-test automations (`aut_3ecd2c9c-…`, `aut_d1f77668-…`) remain in the company list (not customer-facing schedules)

---

## Files changed

- `infra/packages/api/scripts/run-caddington-phase1-uat.mjs` — production UAT runner (no secrets printed)
- `infra/docs/CADDINGTON-PHASE1-OPERATIONAL-UAT.md` — this report

## Migrations

None.

## Deployment IDs

No new deploy. UAT ran against already-live production:

- API / MCP: `https://infra-api.daniel-dwyer123.workers.dev` (prior worker deploy `011e3f23-8b96-4b9c-a483-3511ac16df60`)
- Portal: `https://infra-web.pages.dev` (prior Pages deploy `4d2b92af`)
- D1: `infra-control-plane` `adacb84d-7ee8-4b27-87ff-3d554b563d71` (no schema change)

## Git

- Branch: `cursor/infra-caddington-phase1-uat-d3d8`
- Commit: `10eeca2801ffa81914118be4111539384c7fdf1a`
- PR: https://github.com/daniel00123-tech/Main/pull/358
