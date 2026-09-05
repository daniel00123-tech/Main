# EL Business MCP + INFRA Conversational Architecture

Foundation audit — 5 September 2026

This is an investigation report. It does **not** propose a rewrite in this commit.
It does **not** teach the system individual test questions.
It does **not** add phrase-specific routing.

Evidence sources used in this run:

- Live production `https://api.infrastack.app/health` — SHA `3a46485`, branch `cursor/el-portal-uat-repair-8d24`
- Live D1 `infra-control-plane` (remote)
- Live public EL Worker `GET /health` and `GET /status` at `https://el-business-mcp.daniel-dwyer123.workers.dev`
- Live INFRA MCP facade `tools/list` + `tools/call` for `co_el` / `mcp_el_primary` (machine service identity `other`)
- Live `/api/internal/el-knowledge-search` and `/api/internal/targeted-quality` `warehouse-meta`
- In-repo `infra-api` / `infra-web` / `@infra/shared` code

The EL Business MCP Worker **source is not in this repository**. Native Worker tools were proven from the live `/status` snapshot, the INFRA allowlist, and facade `tools/list` / `tools/call`. They were not line-mapped inside an `el-business-mcp` package, because that package does not exist here.

---

## A. Executive verdict

| Surface | Verdict | Why |
|---|---|---|
| EL MCP foundation | **PARTIAL PASS** | The Worker is live, healthy, and reachable. INFRA binds it and can execute some business reads. The Worker is not in this repo, its own knowledge plane is empty, and INFRA has silently become the real capability layer. |
| Authentication stability | **FAIL** | This is a systemic class of failure, not one missing reconnect. Credentials live on the external Worker, INFRA stores **zero** EL `credential_refs`, connector health is a stale mirror, `/status` can report an expired Xero token while reads still work, and ChatGPT-typed service tokens are now rejected as “not a user login”. |
| Read capability | **PARTIAL PASS** | Live Xero reads, Outlook info-mailbox reads, and warehouse historical reads work on some paths. `xero_get_organisation` is advertised but blocked. Native EL tools `search_elvex_*` / `query_business_data` are allowlisted then denied as high-risk. Warehouse via MCP service identity is permission-denied. |
| Write capability | **PARTIAL PASS** | Action Engine `plan_*` tools are advertised. Direct Xero writes are hidden from the facade. This audit did **not** execute live financial mutations against Elvex. Write + read-back is therefore not proven. |
| Knowledge system | **FAIL** | Three corpora exist and they disagree. EL MCP knowledge = 0 documents. INFRA local D1 = 47 indexed documents. Graph catalogue / `microsoft_index_items` = 501 items. Gateway `search_company_knowledge` returned 0 for a question the local index answered. Exact abbreviations and misspellings miss. There is no dedicated PO or CIS document. |
| Document / upload system | **FAIL** | Ingest is not a reliable READY lifecycle. Ledger: 102 discovered, 53 stored, 29 extracted, 23 indexed events, **57 failed**. Failures include `KNOWLEDGE_UPLOAD_FAILED / Unauthorized` and `MICROSOFT_TENANT_SECRET_MISSING`. Stored ≠ searchable. |
| Conversational intelligence | **PARTIAL PASS** | EL / Caddington Portal + WhatsApp use OpenAI primary (`gpt-5.6-*`) inside a 6-round agent loop. Intended production brain (Workers AI Llama-4 Scout) is **not** the live user-visible brain for those tenants. A large hardcoded control plane still rewrites tools, dates, mailboxes, and recoveries. |
| INFRA Chat integration | **PARTIAL PASS** | Portal Chat uses the same `runIntelligenceTurn` → gateway path. Prior Portal UAT proved some live Xero and knowledge answers. This run did not re-run conversational Portal tests, by required order (MCP first). |
| WhatsApp integration | **NOT TESTED THIS RUN** | Same intelligence layer plus WhatsApp-only fast paths and `recoverFailedIntelligenceTurn`. Webhook remains `https://api.infrastack.app/api/webhooks/whatsapp`. Do not treat WhatsApp as a separate brain. Do not debug it until INFRA Chat passes. |
| Automated regression testing | **FAIL** | Caddington MCP probes exist. EL has targeted-quality / overnight-qa banks. There is **no** post-deploy EL MCP capability gate that must pass before a deployment is considered healthy. Previous Caddington-shaped probes cannot be reused as-is: `identity_type=chatgpt` service tokens are now 401. |
| Observability | **PARTIAL PASS** | `correlationId` / `requestId` / audit events / engineering failure telemetry exist. There is no single operator-visible trace covering channel → model decision → tool → MCP → source → synthesis. |

**Overall platform verdict: PARTIAL PASS on isolated reads, FAIL as a stable foundation.**

The platform can answer some live Xero and mailbox questions today. It cannot yet be trusted as one reliable EL Business MCP capability layer plus one intelligent conversational layer. Failures are still being absorbed by INFRA facades, aliases, mirrors, and phrase-adjacent control-plane rewrites.

---

## B. Actual current architecture

What is genuinely deployed today, not what older registration comments claim.

```
EL Business systems
  Xero (Elvex Property Services Ltd)
  Microsoft 365 (SharePoint / OneDrive / Outlook shared mailboxes)
        │
        │  tokens live on the external Worker
        ▼
el-business-mcp   Cloudflare Worker  v1.2.0
  https://el-business-mcp.daniel-dwyer123.workers.dev/mcp
  public /health + /status
  knowledge: not_configured (0 documents)
  Xero + Microsoft connectors: configured
        │
        │  service binding EL_BUSINESS_MCP
        │  Bearer EL_MCP_AUTH_TOKEN
        ▼
infra-api   Worker  SHA 3a46485   lineage elvex-b8da-superstack
  D1 infra-control-plane
  local company_knowledge_* (47 docs / 292 chunks)
  warehouse_* (Xero historical)
  Microsoft Graph Option B (EL_MS_* / EL_MICROSOFT_*)
  MCP facade https://mcp.infrastack.app → /api/gateway/v1/mcp
  intelligence: OpenAI primary for co_el + co_caddington
  Workers AI bound for fallback / whisper / unscoped tenants
        │
        ├── infra-web  https://app.infrastack.app   Portal Chat
        ├── WhatsApp   https://api.infrastack.app/api/webhooks/whatsapp
        └── ChatGPT / Claude   direct tools, no OpenAI brain
```

### Production stack (confirmed)

| Piece | Live evidence |
|---|---|
| Preferred stack | `infra-api` + `infra-web`. No new Worker was created. |
| WhatsApp webhook | Unchanged: `https://api.infrastack.app/api/webhooks/whatsapp` |
| Cursor in customer path | Explicitly forbidden (`cursorInCustomerPath: false`) |
| OpenAI in production | **Yes**, for EL and Caddington Portal + WhatsApp. `OPENAI_BRAIN_MODE=openai_primary`, models `gpt-5.6-luna` / `gpt-5.6-terra` / `gpt-5.6-sol` |
| Anthropic / Gemini | Not in the production runtime as model providers |
| Intended Workers AI primary | `@cf/meta/llama-4-scout-17b-16e-instruct` with fallback `@cf/meta/llama-3.1-8b-instruct-fast` — used for non-allowlisted tenants / fallback, **not** the live EL user-visible brain |
| EL MCP in this repo | **No source**. Binding only: `wrangler.toml` `EL_BUSINESS_MCP` → service `el-business-mcp` |

### How a tool actually runs

1. Client (Portal / WhatsApp / ChatGPT) hits `infra-api`.
2. Identity + company + RBAC are resolved in INFRA.
3. Portal / WhatsApp call `runIntelligenceTurn` (OpenAI primary for `co_el`).
4. ChatGPT calls `tools/list` / `tools/call` with no intelligence brain.
5. `executeGatewayRequest` dispatches:
   - INFRA-native: Xero reads, Outlook reads, warehouse, document catalogue, knowledge fetch, Action Engine
   - else: `executeRegisteredMcpTool` → `EL_BUSINESS_MCP.fetch()`
6. EL Xero has **no** INFRA `credential_ref_id`, so live Xero reads use the company-MCP proxy and alias map (`search_xero_invoices`, `analyse_xero_sales`, …).

### What registration comments still say (stale)

`register-existing-mcp.ts` still documents EL as “Knowledge not configured; no live business-system connectors” and `initialCapabilities: ["system_health"]`.

Live `/status` contradicts that: Xero, SharePoint, OneDrive, Outlook mailbox, and Outlook calendar are configured. Knowledge on the Worker is still honestly `not_configured`.

`mcp_environments.health_message` is also stale (24 August 2026):

> Public /health ok · authenticated tools/list pending (EL_MCP_AUTH_TOKEN not configured on infra-api)

The secret `EL_MCP_AUTH_TOKEN` **is** present on `infra-api` today. The D1 health row was not refreshed.

---

## C. EL Business MCP connection matrix

Proven from live D1 `connector_instances` + live Worker `/status` + live tool calls. Not inferred from filenames.

| System | INFRA instance | Worker `/status` | Auth method | Token storage | Refresh | Env / secrets | Status |
|---|---|---|---|---|---|---|---|
| EL Business MCP itself | `mcp_el_primary` enabled, `healthy` | healthy v1.2.0 | Bearer `EL_MCP_AUTH_TOKEN` | Cloudflare Worker secret | n/a | `EL_MCP_AUTH_TOKEN`, binding `EL_BUSINESS_MCP` | **CONNECTED** (auth secret exists; D1 health text is stale) |
| Xero | `ci_el_xero` connected, `managed_by=company_mcp`, `external_account_id=ec69a5fb-…`, **no credential_ref** | configured, connected, org Elvex Property Services Ltd | OAuth 2.0 + `offline_access` | **On el-business-mcp** (`xero_connections` table, 1 row). INFRA D1 `credential_refs` for `co_el` = **0** | Worker refresh. `/status` `lastRefreshAt=2026-09-05 13:26:57`, `accessExpiresAt=2026-09-05T13:56:57Z`, `tokenHealth=expiring` | Worker-owned Xero app. INFRA also has `XERO_CLIENT_ID/SECRET` for the INFRA OAuth path, unused for EL because there is no INFRA credential ref | **PARTIAL** — live reads work; status/token metadata is stale; organisation tool blocked |
| Microsoft / Outlook | `ci_el_outlook` connected, company_mcp, no credential_ref | configured, approved `info@` + `finance@` | Client credentials (Option B) | INFRA: `microsoft_tenant_identities` public IDs + secret binding `EL_MS_CLIENT_SECRET`. Worker also has tenant/client/secret configured | App-token acquire. `last_token_success=2026-09-05T12:05:16Z` | `EL_MS_TENANT_ID`, `EL_MS_CLIENT_ID`, `EL_MS_CLIENT_SECRET` plus aliases `EL_MICROSOFT_*`. Also global `MICROSOFT_*` | **PARTIAL** — mailbox reads work on INFRA `outlook_*`. Native `search_elvex_email` denied. Dual secret names |
| SharePoint | `ci_el_sharepoint` connected (mirrored Microsoft snapshot) | configured | Same Microsoft app | Same | Same | Same | **PARTIAL** — mirrored healthy; catalogue listing works; native file search denied |
| OneDrive | `ci_el_onedrive` connected (same mirrored snapshot) | configured | Same Microsoft app | Same | Same | Same | **PARTIAL** — same as SharePoint |
| Outlook calendar | **No INFRA connector instance** | configured | Same Microsoft app | Worker | Worker | Worker Microsoft secrets | **PARTIAL** — exists on Worker only; not a first-class INFRA connector |
| Knowledge (Worker) | MCP `knowledge_document_count` null | `not_configured`, 0 docs | n/a | none | none | EL MCP has no `/admin/knowledge` | **NOT IMPLEMENTED** on the Worker |
| Knowledge (INFRA local) | D1 `company_knowledge_documents` | n/a | n/a | D1 extracted text + chunks | re-index on ingest | Azure OCR secrets optional | **PARTIAL** — 47 docs indexed; search path split |
| Warehouse | INFRA D1 warehouse tables | Worker `structuredData.mode=warehouse` (9 tables / 532 records — Worker-local, not INFRA warehouse) | Uses Xero connection | INFRA warehouse D1 | Cron 37 slots/week Europe/London | n/a | **PARTIAL** — historical months work; current-month warehouse query failed; last sync `2026-09-05T11:00:11Z` |
| BigChange | `ci_el_bigchange` draft / not_configured | not_configured | none | none | none | none | **NOT IMPLEMENTED** |
| Freshdesk | `ci_el_freshdesk` draft / not_configured | not_configured | none | none | none | none | **NOT IMPLEMENTED** |
| Commusoft | **No live instance** | not present | catalogue deferred | none | none | none | **NOT IMPLEMENTED** |
| Google Drive | Caddington-only catalogue | not present for EL | n/a | n/a | n/a | n/a | **NOT IMPLEMENTED** for EL |

### Authenticator records (expected vs actual)

| Item | Expected | Actual |
|---|---|---|
| Tenant | EL Business `co_el` | `co_el` |
| MCP | `mcp_el_primary` | present, enabled |
| Xero connector ID | `conn_xero` / `ci_el_xero` | present, `auth_status=connected` |
| Xero auth record in INFRA | encrypted `credential_refs` row | **missing** — by design for company-MCP-managed Xero |
| Xero auth record on Worker | `xero_connections` (1 row) | present; last API 13:49 UTC; access token expiry 13:56 UTC |
| Microsoft identity | `mti_co_el_microsoft` | present, active, `auth_mode=client_credentials`, secret binding `EL_MS_CLIENT_SECRET` |
| Microsoft tenant | `af32e619-3647-44a2-85d9-1c45457c0e91` | matches code constant and D1 |
| Microsoft client | `f8ec6a91-f043-4f63-8800-64135af48c4e` (“INFRA - Elvex MCP”) | matches |

---

## D. Complete MCP tool inventory

Two inventories must not be collapsed:

1. **Advertised on the INFRA facade** (`tools/list` for a machine identity with Xero + Outlook + knowledge scopes): **69 tools**.
2. **Allowlisted as downstream EL MCP names** in D1 `mcp_tool_allowlist`: **28 tools**.

Facade `tools/list` injects INFRA-native tools even when the Worker does not expose them. That is why the live catalogue is larger than the Worker allowlist.

### D1. Downstream EL names (allowlist — what INFRA believes the Worker exposes)

| Tool | System | R/W | Auth | Notes |
|---|---|---|---|---|
| `system_health` | EL MCP | read | MCP bearer | Live PASS |
| `database_summary` | EL MCP | read | MCP bearer | Knowledge collections only |
| `search_company_knowledge` | knowledge | read | MCP bearer | Worker index is empty |
| `get_knowledge_document` | knowledge | read | MCP bearer | Documented stub on Elvex MCP |
| `search_elvex_email` | Outlook | read | MCP + RBAC | Allowlisted; live call **permission_denied** / mis-tagged as Xero |
| `get_elvex_email` | Outlook | read | MCP + RBAC | Allowlisted; not separately called this run |
| `search_elvex_files` | files | read | MCP + RBAC | Live **permission_denied** high_risk |
| `get_elvex_file` | files | read | MCP + RBAC | Allowlisted |
| `query_business_data` | mixed | read | MCP + RBAC | Live **permission_denied**, mis-tagged as Xero |
| `search_xero_contacts` | Xero | read | company MCP | Alias target |
| `search_xero_invoices` | Xero | read | company MCP | Alias target used by live reads |
| `xero_get_organisation` | Xero | read | INFRA contract | Advertised; live **connector_not_configured** |
| `xero_list_contacts` | Xero | read | company MCP | Live PASS |
| `xero_get_contact` | Xero | read | company MCP | Advertised |
| `xero_search_invoices` | Xero | read | company MCP | Live PASS |
| `xero_get_invoice` | Xero | read | company MCP | Live PASS |
| `xero_list_overdue_invoices` | Xero | read | company MCP | Live PASS |
| `xero_list_payments` | Xero | read | company MCP | Advertised |
| `xero_list_accounts` | Xero | read | company MCP | Advertised |
| `xero_list_bank_transactions` | Xero | read | company MCP | Advertised |
| `xero_profit_and_loss` | Xero | read | company MCP | Live PASS (alias to financial summary) |
| `xero_balance_sheet` | Xero | read | company MCP | Advertised |
| `xero_aged_receivables` | Xero | read | company MCP | Advertised |
| `xero_sales_summary` | Xero | read | company MCP | Live PASS £5,094 |
| `xero_top_customers` | Xero | read | company MCP | Advertised |
| `xero_top_suppliers` | Xero | read | company MCP | Advertised |
| `xero_list_tax_rates` | Xero | read | company MCP | Advertised |
| `xero_vat_capability` | Xero | read | company MCP | Advertised |

### D2. INFRA-injected facade tools (exist in production today)

**Knowledge / catalogue**

| Tool | R/W | Required | Optional | Implementation | Live |
|---|---|---|---|---|---|
| `search` | read | `query` | | `mcp-knowledge-standard.ts` + gateway | PASS (Profit Margin Policy hit; different filename than local index) |
| `fetch` | read | `id` | | `document-fetch.ts` | not separately proven |
| `search_company_knowledge` | read | `query` | | gateway → EL MCP (empty) | FAIL empty vs local index |
| `get_knowledge_document` | read | `document_id` | title / id aliases | `document-fetch.ts` | PARTIAL — HTTP 200, empty body for `id=12` |
| `list_documents` | read | | source, sort, limit, file_type, dates | `document-catalogue.ts` | PASS (Graph catalogue, not the 47 local docs) |
| `ask_document` | read | | | ask-document service | advertised |
| `database_summary` | read | | | MCP / facade | advertised |
| `system_health` | read | | | EL MCP | PASS |

**Outlook (INFRA-native)**

| Tool | R/W | Required | Implementation | Live |
|---|---|---|---|---|
| `outlook_search_mailbox` | read | `query` | `microsoft-outlook-*.ts` | PASS (4 messages) |
| `outlook_list_messages` | read | | same | PASS (10 messages, info@) |
| `outlook_get_message` | read | mailbox + messageId | same | advertised |
| `outlook_get_conversation` | read | mailbox + conversationId | same | advertised |
| `outlook_list_folders` | read | mailbox | same | advertised |
| `outlook_list_attachments` | read | mailbox + messageId | same | advertised |
| `outlook_get_attachment` | read | mailbox + messageId + attachmentId | same | advertised |

**Xero reads (INFRA contracts, EL execution via company MCP)**

Implemented read contracts: organisation, contacts list/get, invoices search/get/overdue, payments, accounts, bank transactions, P&L, balance sheet, aged receivables, sales summary, top customers, top suppliers, tax rates, VAT capability.

**Warehouse**

`warehouse_sales_analysis`, `warehouse_invoice_analysis`, `warehouse_receivables_analysis`, `warehouse_customer_analysis`, `warehouse_query`.

Internal `warehouse-meta`: PASS for closed months. MCP service identity: permission_denied. Current-month warehouse query: FAIL.

**Action Engine (writes as plans, not direct MCP writes)**

`get_action_plan`, `confirm_action_plan`, `cancel_action_plan`, `list_pending_actions`, `dry_run_action_plan`, plus `plan_xero_*` for credit, draft invoice, remittance allocation, approve/send invoice, draft/approve bill, draft/approve credit note, create contact, create-approve-send, update draft, credit allocation, void, delete test draft, `list_xero_test_artefacts`.

Direct `xero_create_*` / approve / send tools are **hidden** from `tools/list`.

**Automations**

`automation_list/get/get_run/plan/create/plan_update/update/pause/resume/run_now/delete`.

### Not implemented (genuinely absent)

- BigChange jobs / customers / appointments
- Commusoft
- Freshdesk
- Google Drive for EL
- CRM write tools
- Outlook send / reply / delete
- Calendar tools on the INFRA facade (Worker reports calendar configured)

---

## E. Live / direct tool test results

Acceptance key: **PASS / PARTIAL / FAIL / NOT IMPLEMENTED / BLOCKED BY AUTH**

Failed-layer key: AUTH / TOKEN REFRESH / TENANT RESOLUTION / PERMISSION / MCP TOOL / SCHEMA / PARAMETER MAPPING / SOURCE API / SOURCE DATA / STORAGE / DEPLOYMENT / TIMEOUT / RATE LIMIT / UNKNOWN

### Read tests (direct, no conversational model)

| Test | Tool | Result | Layer if failed | Evidence |
|---|---|---|---|---|
| Worker public health | GET `/health` | **PASS** | | `ok`, company EL Business, v1.2.0 |
| Worker public status | GET `/status` | **PASS** | | connectors + Xero org + Microsoft mailboxes |
| MCP initialize | facade | **PASS** | | server `infra-gateway` |
| Tool discovery | `tools/list` | **PASS** | | 69 tools |
| System health | `system_health` | **PASS** | | Worker healthy; knowledge not_configured |
| Xero org | `xero_get_organisation` | **FAIL** | PERMISSION / SCHEMA | `-32003` `connector_not_configured` — “capability isn’t available through this connection yet” |
| Current sales 1–5 Sep 2026 | `xero_sales_summary` | **PASS** | | `sales_total=5094`, via company MCP |
| Search contacts “Elvex” | `xero_list_contacts` | **PASS** | | 1 contact: Elvex Property Services Ltd |
| Unpaid invoices | `xero_search_invoices` unpaidOnly | **PASS** | | 3 invoices, first INV-02276 |
| Overdue invoices | `xero_list_overdue_invoices` | **PASS** | | 3 invoices, first INV-02164 |
| Invoice INV-02277 | `xero_get_invoice` | **PASS** | | invoice object returned |
| March P&L / financial summary | `xero_profit_and_loss` | **PASS** | | org Elvex Property Services Ltd |
| Warehouse March sales | internal warehouse-meta | **PASS** | | £23,434.60 COMPLETE as-of 11:00Z |
| Warehouse current month | warehouse-meta | **FAIL** | SOURCE DATA | `ok: false`, sales null |
| Warehouse via MCP identity | `warehouse_sales_analysis` | **BLOCKED BY AUTH** | PERMISSION | `userRole=None`, `xero.sales.read` denied |
| Local knowledge “PO process” | internal search | **PARTIAL** | SOURCE DATA | 1 hit: Subcontractor Payment Process (PO mentioned, not a PO procedure) |
| Local knowledge “CIS” | internal search | **FAIL** | SOURCE DATA | 0 hits |
| Local knowledge “Construction Industry Scheme” | internal search | **FAIL** | SOURCE DATA | 0 hits |
| Local knowledge exact title Profit Margin Policy | internal search | **PASS** | | 1 hit, correct doc |
| Local knowledge “Creating a supplier” | internal search | **PASS** | | hits `Creating  a supplier.xlsx` |
| Local knowledge conceptual purchase procedure | internal search | **PARTIAL** | SOURCE DATA | payment/booking docs, not a PO policy |
| Local knowledge misspelling | internal search | **FAIL** | MCP TOOL / SCHEMA | 0 hits for `subcontracter paymant prosess` |
| Facade knowledge search | `search_company_knowledge` | **FAIL** | MCP TOOL | 0 results — Worker index empty |
| Facade `search` | `search` | **PARTIAL** | | 1 hit `Profit Margin Policy__dd46ef906f.docx` (Graph-style name, not local id 10) |
| Full document id 12 | `get_knowledge_document` | **FAIL** | PARAMETER MAPPING | HTTP 200, empty title/text (`id` vs `document_id`) |
| Catalogue list | `list_documents` | **PASS** | | newest Graph files, not the 47 local attachment docs |
| Info mailbox latest | `outlook_list_messages` | **PASS** | | 10 messages |
| Info mailbox search “invoice” | `outlook_search_mailbox` | **PASS** | | 4 messages |
| Native `search_elvex_email` | company MCP | **BLOCKED BY AUTH** | PERMISSION | high_risk, wrongly labelled as Xero capability |
| Native `search_elvex_files` | company MCP | **BLOCKED BY AUTH** | PERMISSION | high_risk |
| Native `query_business_data` | company MCP | **BLOCKED BY AUTH** | PERMISSION | high_risk, wrongly labelled as Xero |

### Write tests

| Test | Result | Layer | Why |
|---|---|---|---|
| Direct Xero write via facade | **NOT IMPLEMENTED** on facade | PERMISSION | Write tools stripped from `tools/list` |
| Action Engine plan tools | **PARTIAL** | | Advertised; `plan_*` does not mutate |
| Live create/update + read-back | **NOT TESTED** | | Deliberate: this run does not mutate genuine Elvex records. A later controlled `INFRA-TEST-*` artefact pass is required. |
| ChatGPT-typed service token | **FAIL** | AUTH | `identity_type=chatgpt` → 401 “Human ChatGPT connections must use INFRA OAuth” |

A successful HTTP 200 was **not** treated as proof. Xero and Outlook reads returned source records. Knowledge fetch HTTP 200 with empty body was marked FAIL.

---

## F. Authenticator root-cause analysis

### What is failing

There is no string `AUTH_NOT_FOUND` or “authenticator not found” in this repository. The user-facing symptom is produced by **several overlapping lookup failures** that all present as “the connection that worked yesterday is gone”.

The authenticator that matters for EL Xero is:

- **System:** Xero
- **Tenant:** EL Business / Elvex Property Services Ltd (`co_el`)
- **Connector ID:** `conn_xero` / instance `ci_el_xero`
- **Expected auth record:** OAuth tokens for tenant `ec69a5fb-1b91-4cb5-a7f5-704dcecc5d2d`
- **Where it should be stored:** on `el-business-mcp` (`xero_connections`), because `managed_by=company_mcp` and INFRA `credential_ref_id` is null
- **Does it still exist?** Yes — Worker `/status` still reports connected, org name, scopes, last API OK
- **How it is looked up in INFRA:** `company_id + connector_definition_id=conn_xero + auth_status=connected + external_account_id`
- **Lookup tenant/user correctness:** company-scoped, not user-scoped. Service identities with no Elvex role then fail later at RBAC, which is a different failure that *looks* like “Xero isn’t available”

### Why something that worked yesterday becomes “not found” today

This is a **category**, not a one-off reconnect.

1. **Split brain credential store.** EL Xero tokens are not in INFRA D1. INFRA cannot refresh, inspect expiry, or recover them. If the Worker KV/D1 row is missing, rotated, or unreadable after a deploy, INFRA still shows yesterday’s mirrored `auth_status=connected`.

2. **Mirror is not source of truth.** `mcp-connector-mirror.ts` copies `/status` into `connector_instances`. Freshness window is 90 seconds in code, but `mcp_environments.health_message` is still 24 August. Connector rows were last mirrored 13:26 UTC today. Operators and code both trust a snapshot.

3. **Access tokens expire about every 30 minutes.** Live `/status` at 16:53 UTC still advertised `accessExpiresAt=13:56:57Z` and `tokenHealth=expiring`. Reads at 16:55 still succeeded, which means either on-demand refresh works and `/status` is stale, or a later refresh is not published. Either way, status cannot be used to decide “connected”.

4. **Refresh lives in an out-of-repo Worker.** This repo cannot prove the refresh cron, the lock, or the failure path. When refresh fails, the next live call becomes 401 / `XERO_AUTH_EXPIRED` / `CONNECTOR_NOT_CONNECTED` depending on which adapter catches it.

5. **Secret-name drift across deploys.** Microsoft uses `EL_MS_CLIENT_SECRET` and alias `EL_MICROSOFT_CLIENT_SECRET`. Both secrets exist today. Ingest still recorded `MICROSOFT_TENANT_SECRET_MISSING` and `KNOWLEDGE_UPLOAD_FAILED / Unauthorized`. A deploy that binds one name and not the other makes yesterday’s working Graph app “disappear” without deleting the D1 identity row.

6. **MCP bearer vs ChatGPT OAuth.** A machine token with `identity_type=chatgpt` now gets 401 on the facade. Older probes and possibly some ChatGPT “API key” setups used that type. The connection exists; the lookup class changed.

7. **Tool-to-capability mis-map.** `search_elvex_email` and `query_business_data` were denied with the **Xero** “you don’t have access to Xero financial data” message. The authenticator is present. The permission table lies. That is indistinguishable from “Outlook isn’t connected” in a chat answer.

8. **Organisation tool vs other Xero tools.** `xero_get_organisation` is advertised and allowlisted, then rejected `connector_not_configured`, while `xero_sales_summary` against the same connection succeeds. Capability gating is per-tool, not per-connector.

9. **No INFRA credential persistence for EL.** Encrypted credential persistence did not fail — it was never used. Environments differ: Caddington can be INFRA-OAuth; EL is company-MCP-owned. A “reconnect in the portal” that writes an INFRA credential_ref would create a second, conflicting source of truth.

### What would eliminate the category

- One authoritative connection record per connector, with last refresh, expiry, last source API, and last error, updated on every call — not only on mirror ticks.
- EL MCP source in a repo INFRA can review, or INFRA-owned tokens for EL Xero (one home, not two).
- Health checks that fail a deploy when authenticated `tools/list` or a Xero/Microsoft probe fails.
- Structured codes (`AUTH_EXPIRED`, `AUTH_REFRESH_FAILED`, `AUTH_NOT_FOUND`) instead of recycled Xero permission copy.
- Stop treating mirrored `connected` as proof the authenticator can be used *now*.

Do **not** “just reconnect Xero” and close this.

---

## G. Knowledge retrieval analysis

### What exists

Local INFRA index (`co_el`): **47 documents, 292 chunks**, created 4–5 September 2026. Mostly Outlook attachment ingest.

Useful operational docs present:

- `Profit Margin Policy.docx`
- `Subcontractor Payment Process.docx`
- `Subcontractor Booking process.docx`
- `Admin Structure September 2026.docx`
- `Elvex_Finance_Admin_AI_Knowledge_Base.docx` (67 chunks)
- `Creating  a supplier.xlsx`
- `OnCall_and_Holidays_2026 (1).xlsx`
- `SRFM Sub Contractor MASTER - Elvex Property Services.docx`

Not present as titles:

- CIS / Construction Industry Scheme
- Purchase order procedure / “How we raise a PO”

EL MCP Worker knowledge: **0 documents, status `not_configured`**.

Graph / Worker `microsoft_index_items`: **501** items. Catalogue `list_documents` returns a **different** newest-file set (`LJ-461.pdf`, `HOMEFLOW.pdf`, …).

### Direct search results

| QUESTION | EXPECTED DOCUMENT | SEARCH RESULTS | RANKING | RELEVANT? | ENOUGH TO ANSWER? | PASS/FAIL |
|---|---|---|---|---|---|---|
| How should I raise a purchase order? | A PO procedure. None exists. | Subcontractor Payment Process (snippet mentions purchase order on invoices) | 1 | Weakly | No — invoice submission, not raising a PO | **FAIL** as PO procedure / **PARTIAL** as “some PO text exists” |
| What is the correct procedure when someone needs to purchase something? | Same | Payment Process + Booking Process | 1–2 | Weakly | No | **PARTIAL** |
| CIS | CIS procedure | 0 | n/a | No | No | **FAIL** |
| Construction Industry Scheme | CIS procedure | 0 | n/a | No | No | **FAIL** |
| subcontractor payment process | Payment Process.docx | Payment + Booking | correct | Yes | Yes for payment process | **PASS** |
| Profit Margin Policy | that title | exact title | 1 | Yes | Yes | **PASS** |
| Creating a supplier | Creating  a supplier.xlsx | that file + SRFM + a WO PDF | 1 | Yes | Partial (xlsx, 1 chunk) | **PASS** |
| subcontracter paymant prosess | Payment Process | 0 | n/a | No | No | **FAIL** |
| Facade `search_company_knowledge` “How should I raise a purchase order?” | local doc 12 | 0 | n/a | No | No | **FAIL** — empty Worker index |
| Facade `search` “Profit Margin Policy” | local doc 10 | `Profit Margin Policy__dd46ef906f.docx` | 1 | Probably | Unknown without fetch | **PARTIAL** |

### Why searches fail when documentation exists

1. **The tool the model is told to call does not search the corpus the documents live in.** Gateway `search_company_knowledge` goes to EL MCP. EL MCP has no knowledge. The 47 documents live in INFRA D1. Internal search merges both; the facade path does not.

2. **Three corpora, three names.** Local D1 titles, Graph catalogue titles, and hashed SharePoint names are not the same object. `list_documents` ≠ local search.

3. **Lexical + light synonym expansion, no real hybrid retrieval.** `company-knowledge-index.ts` has stopwords, stems, and a small alias table (`payment/payments`, `process/procedure`). It does not expand CIS → Construction Industry Scheme, and it does not tolerate misspellings.

4. **Abbreviations that never appear in the text cannot hit.** Exact `"CIS"` is not in the indexed titles or, from prior UAT, the payment-process body.

5. **Conceptual questions retrieve adjacent process docs.** “How do we purchase something?” lands on subcontractor payment because those chunks contain “purchase order” as an invoice field.

6. **Chunking is crude.** Many PDFs are 6 identical-sized OCR chunks. The finance knowledge base is 67 chunks. There is no neighbouring-chunk expansion or rerank on the facade path.

7. **Full-document fetch is not reliable.** `get_knowledge_document` is a stub on the Worker; INFRA fetch requires the right id/title/drive. Passing `id=12` returned empty.

Do **not** fix this with a CIS synonym list or a hardcoded PO question. The first fix is **one retrieval path over one authoritative index**, then hybrid lexical + semantic search, then fetch of the winning document.

---

## H. Storage / upload analysis

### Actual lifecycle today

Ingest ledger types: `discovered` → `fetched` → `stored` → `extracted` → `indexed`, plus `skipped` / `duplicate` / `failed` / `source_observed`.

There is **no** user-visible `RECEIVED / STORED / PARSING / INDEXING / READY / FAILED` contract. Local index rows jump to `documentStatus: "indexed"` only after extract + chunk succeed. A file can be stored and still never become searchable.

### Live EL ledger

| Event | Count |
|---|---|
| discovered | 102 |
| fetched | 53 |
| stored | 53 |
| extracted | 29 |
| indexed | 23 |
| skipped | 54 |
| failed | 57 |
| duplicate | 17 |

Failed / skipped reasons:

| Code | Count | Meaning |
|---|---|---|
| SKIP_INLINE | 49 | inline images / signatures — expected |
| LEGACY_FAILURE_UNLOGGED | 28 | incomplete ledger, recovered as failed |
| KNOWLEDGE_UPLOAD_FAILED / Unauthorized | 16 | upload to landing zone / MCP admin rejected |
| ATTACHMENT_ENUM_FAILED / MICROSOFT_TENANT_SECRET_MISSING | 11 | Graph attachment list failed because secret binding was missing at that time |
| UNSUPPORTED_TYPE | 5 | format not parsed |
| EXTRACT_EMPTY_TERMINAL | 1 | no text |
| RETRIEVAL_UNVERIFIED | 1 | stored file not found in later search |

### Weaknesses

- “Success” can mean bytes reached storage.
- 53 stored vs 23 indexed events vs 47 current local docs — the ledger and the index have drifted.
- Unauthorized upload and missing Microsoft secret are authenticator bugs surfacing as knowledge bugs.
- PDF / DOCX / XLSX / JPEG are supported when extract works. Unusual filenames exist (`Creating  a supplier.xlsx` double space) and do search if the query matches.
- Duplicate re-uploads are recorded, but READY is not re-verified.
- EL MCP `/admin/knowledge` is not a production path (`shouldUseLocalCompanyKnowledgeIndex` is true for `EL_BUSINESS_MCP`).
- Catalogue listing and semantic index are not the same READY set.

A document must not be called READY unless a search for its title and a fetch of its id both succeed.

---

## I. Conversational intelligence analysis

### How a natural-language message becomes a tool call today

**EL / Caddington Portal and WhatsApp (production):**

```
user message
  → identity / company / RBAC
  → runIntelligenceTurn
  → resolveBrainPolicy → openai_primary
  → classifyScope (hint only; does not force the tool)
  → OpenAI completer (fast/default/reasoning)
  → up to 6 model↔tool rounds
  → rewriteAccountingTool / prepareToolArguments / authorizeToolCall
  → executeGatewayRequest
  → observation back to the model
  → quality guard
  → natural-language answer
```

**ChatGPT / Claude MCP:**

```
tools/list + tools/call
  → no intelligence brain
  → same gateway
```

**Unscoped / automation / HT:**

Cloudflare Workers AI (`llama-4-scout` / `llama-3.1-8b-fast`) plus the **deterministic** `classifyScope` → `runDeterministicRead` path.

### What the model actually receives

- conversation context
- company context
- a **filtered** tool catalogue (RBAC + connector capabilities + aliases)
- recipe hints (OpenAI primary)
- authoritative Europe/London runtime dates (after the Portal UAT repair)

### What the control plane still decides for the model

- warehouse vs live Xero
- mailbox address (info@ vs finance@)
- date overwrite (`withResolvedBusinessDates`)
- INV- → `xero_get_invoice`
- process/procedure → knowledge search
- WhatsApp finance failure → force `xero_sales_summary`

This is not a command parser only. It is also not a free agent. Roughly: the model chooses the tool under OpenAI primary; INFRA rewrites the dangerous parts.

---

## J. Hardcoded routing audit

Significant manual routing still in production code. This is not a complete token dump; it is every **behaviour-changing** special case found in the intelligence path.

| Kind | Where | Behaviour |
|---|---|---|
| Regex scope tree | `intelligence/scope.ts` | Finance / email / knowledge / catalogue / admin / discourse |
| Business-system intent map | `permissions/business-system-intent.ts` | Xero vs mailbox vs admin vs payments |
| Predetermined Xero tool pick | `businessToolForIntent` / `pickBusinessTool` | overdue, P&L, INV-, top customers, sales summary |
| Predetermined mailbox pick | `pickMailboxTool` | list vs search |
| Connector capability map | `company-tool-registry.ts` | `conn_xero` → accounting, `conn_outlook_shared` → EMAIL_* |
| Vendor alias map | `company-tool-registry.ts` | `search_emails` → `outlook_search_mailbox`, file-list aliases → `list_documents` |
| Live vs warehouse rewrite | `rewriteLiveAccountingTool` / `rewriteHistoricalAccountingTool` | current/open → `xero_*`; closed → `warehouse_*` |
| INV- rewrite | `rewriteExactAccountingTool` | force `xero_get_invoice` |
| Sharon name special case | `orchestrator.ts` | `sharon` → mailbox query `Sharon` |
| Finance mailbox constant | `ELVEX_FINANCE_MAILBOXES` | `finance@elvexpropertyservices.com` |
| Info mailbox constant | `ELVEX_INFO_MAILBOXES` | `info@elvexpropertyservices.com` |
| PO + invoice → Xero search query=PO | `business-system-intent.ts`, `orchestrator.ts` | parameter injection |
| PO process topic string | `scope.ts` | lastAnswerTopic “the PO process” |
| Process / procedure / subcontractor | `evidence-plan.ts` | semantic knowledge, not CIS-specific |
| Deterministic multi-tool plan | `evidence-plan.ts` `minimumToolsForText` | skipped under OpenAI primary |
| Deterministic read / bootstrap | `orchestrator.ts` | skipped under OpenAI primary |
| Conversation keyword replies | `conversation.ts` | thanks / hi / rephrase / memory |
| Fast-path greetings | `fast-path.ts` / `router.ts` | skip the model |
| Write-intent block | `router.ts` / `scope.ts` | controlled action, no free write |
| WhatsApp finance recovery | `whatsapp-intelligence.ts` | failed finance → `xero_sales_summary` |
| WhatsApp keyword recovery | same | sales/revenue/invoice/xero regex |
| Legacy WhatsApp planner | `whatsapp-plan.ts` | **not** the live path except button actions |
| Recipe sanitiser | `solution-recipes.ts` | strips historic concrete dates |
| Quality guard | `response-guard.ts` | rejects empty / title-dump answers |
| Tool allowlists | `mcp_tool_allowlist` + `tool-auth.ts` + Elvex RBAC | hard catalogue filter |
| Web-search private-system block | `web-search.ts` | weather/news blocked if private systems match |

No UAT-question-ID handlers were found. Several of the above were introduced because classes of UAT questions failed (current month, CIS synthesis, Sharon mail). They are still hardcoded behaviour.

---

## K. Target architecture

```
USER MESSAGE
  → identity
  → company / tenant
  → RBAC
  → ONE conversational intelligence layer
  → model receives:
        conversation context
        company context
        permitted MCP tool catalogue
        schemas
        London runtime
  → model decides:
        answer | search knowledge | one tool | many tools | iterate
  → MCP executes only allowed, schema-valid, audited operations
  → observation
  → model may call again
  → natural-language answer

Clients (same intelligence, different transport):
  INFRA Chat
  WhatsApp
  ChatGPT / Claude MCP
  future channels
```

Rules that should stay in the platform, not in the prompt:

- authentication
- tenant isolation
- RBAC
- schema validation
- source-system permissions
- financial write / Action Engine gates
- idempotency
- audit

Rules that should **leave** the intelligence layer over time:

- Sharon
- PO topic strings
- WhatsApp finance regex recovery
- predetermined connector → tool maps used as a substitute for tool descriptions
- dual knowledge indexes

Do not replace OpenAI / Anthropic / Gemini as part of this audit. Do not add a new Worker. Do not make Cursor part of the runtime.

The EL MCP must become a **capability layer**: broad read/write/search tools with strict safety, not a bag of prompt handlers. The model decides what it needs. The MCP defines what it is allowed to do.

---

## L. Missing capabilities

Only systems that are actually connected.

### Xero — READ missing or incomplete

- Organisation profile via the advertised tool (broken today)
- Bank summary / trial balance / executive summary (scopes exist on the Worker; no INFRA tools)
- Attachment download from a Xero invoice
- Credit-note read as a first-class tool
- Aged payables (aged receivables exists)
- Repeating invoices / quotes / purchase orders in Xero

### Xero — WRITE missing as safe general tools

Plans exist. Proven execute + read-back does not. Still needed as **controlled** capabilities, not chat shortcuts:

- Draft invoice / bill / credit note
- Approve / send
- Allocate remittance
- Create/update contact
- Void / delete **test** drafts only

### Xero — SEARCH missing

- Full-text across invoice reference + contact + line description in one general search
- Supplier bill search equivalent to sales invoice search

### Microsoft — READ / SEARCH missing

- Calendar on the INFRA facade
- Conversation-quality attachment “was there a file?” as a first-class observation, not a second tool the model often skips
- User mailboxes (intentionally restricted; do not silently expand)
- OneDrive / SharePoint content search that is the same index as knowledge

### Microsoft — DOCUMENT missing

- Fetch by catalogue id that is the same id search returns
- READY-state promotion from Graph item → searchable document

### Knowledge — missing

- One index
- Hybrid lexical + semantic
- Neighbouring chunks
- Full-document expansion
- Rerank
- Honest `KNOWLEDGE_NO_MATCH` when the corpus does not contain the procedure

### CRM / field service

BigChange / Commusoft / Freshdesk: jobs, appointments, quotes, POs, customers — **not implemented**. Do not catalogue them as live.

---

## M. Regression strategy

A green Worker deploy is not a healthy capability deploy.

### Level 1 — Authentication / connector health

After every `infra-api` or `el-business-mcp` deploy:

- authenticated `tools/list` through the facade with a **machine** identity (`other` / automation), not `chatgpt`
- Worker `/status` Xero `connected` **and** `lastApiAt` within the last refresh window
- Microsoft token acquire (`last_token_success`)
- fail the gate if `EL_MCP_AUTH_TOKEN` or `EL_MS_CLIENT_SECRET` is unbound

### Level 2 — MCP individual tools

Direct `tools/call` for every advertised **read** tool. Assert source records, not HTTP 200. Include `xero_get_organisation` (currently red).

### Level 3 — Knowledge retrieval

Fixed document set, rotating queries: exact title, exact phrase, natural question, synonym, abbreviation, misspelling, multi-doc. Assert **no** phrase map was added when a case fails.

### Level 4 — Conversational tool selection

Many phrasings, no golden questions in production code. Score: permitted tool chosen, not a specific sentence.

### Level 5 — INFRA Chat end-to-end

Portal user → intelligence → MCP → synthesis. Trace ID required.

### Level 6 — WhatsApp end-to-end

Same intelligence. Channel-only assertions: webhook, session, split messages.

Existing assets to reuse, not replace: `targeted-quality`, `overnight-qa`, `probe-mcp-acceptance.mjs` (must be retargeted from Caddington and `identity_type=chatgpt`).

---

## N. Remediation plan

No uncontrolled rewrite in this run. Order is mandatory.

### P0 — Foundational failures

#### P0.1 Split-brain Xero authenticator

- **PROBLEM:** EL Xero tokens live only on `el-business-mcp`. INFRA mirrors `connected` and cannot prove refresh.
- **ROOT CAUSE:** `managed_by=company_mcp` + no `credential_ref` + stale `/status`.
- **FIX:** Make one store authoritative. Either bring EL MCP source + connection health into a reviewable contract INFRA polls on every Xero call, or move EL Xero tokens into INFRA encrypted refs (without rotating production secrets in this audit). Publish `lastRefreshAt` / `accessExpiresAt` / last error on every read.
- **COMPONENTS:** `el-business-mcp` (external), `xero-company-mcp.ts`, `mcp-connector-mirror.ts`, `xero-tools.ts`
- **TEST:** Level 1 gate + `xero_sales_summary` + `xero_get_organisation` after token TTL.
- **DONE:** Yesterday’s connection cannot silently become “not found” without a structured `AUTH_EXPIRED` / `AUTH_REFRESH_FAILED` and a failed deploy gate.

#### P0.2 Three knowledge corpora

- **PROBLEM:** Worker index 0, INFRA D1 47, Graph 501. Facade search misses local docs.
- **ROOT CAUSE:** `search_company_knowledge` executes on EL MCP; local index is only merged on internal/WhatsApp helpers.
- **FIX:** One retrieval function used by gateway, Portal, WhatsApp, and ChatGPT `search`. Catalogue list stays separate and is labelled as catalogue.
- **COMPONENTS:** `gateway.ts`, `company-knowledge-index.ts`, `mcp-knowledge-standard.ts`, `document-fetch.ts`
- **TEST:** Facade `search_company_knowledge` “Profit Margin Policy” returns local doc 10; fetch returns text.
- **DONE:** A document that is READY is returned by the same tool the model is told to call.

#### P0.3 Upload Unauthorized / missing Microsoft secret

- **PROBLEM:** 16 Unauthorized uploads, 11 `MICROSOFT_TENANT_SECRET_MISSING`.
- **ROOT CAUSE:** Dual secret names and MCP admin token not always bound; landing-zone upload treated as success path without auth proof.
- **FIX:** Fail ingest at RECEIVED if Graph token or MCP admin auth is missing. Do not mark stored. Bind one Microsoft secret name as canonical.
- **COMPONENTS:** `outlook-attachment-ingest.ts`, `knowledge-intake.ts`, `microsoft-tenant-identity.ts`, `mcp-admin-bridge.ts`
- **TEST:** Ingest a tiny INFRA-TEST.txt and assert READY + search + fetch.
- **DONE:** No Unauthorized stored-but-unsearchable rows.

#### P0.4 Structured auth / permission errors

- **PROBLEM:** Outlook file/email tools return Xero permission copy. Organisation tool returns `connector_not_configured` while sales works.
- **ROOT CAUSE:** Action/risk maps treat unknown MCP tools as high-risk Xero-ish capabilities.
- **FIX:** Introduce the machine-readable set requested (AUTH_*, CONNECTOR_*, MCP_*, KNOWLEDGE_*, DOCUMENT_*, WRITE_*). Map each adapter once.
- **COMPONENTS:** `errors.ts`, `gateway.ts`, `public-errors.ts`, outlook/xero company-MCP adapters
- **TEST:** `search_elvex_email` denied ≠ “Xero financial data”.
- **DONE:** One code per failure class; conversational layer only translates.

### P1 — Production reliability

#### P1.1 Authenticated tools/list health refresh

- **PROBLEM:** D1 still says `EL_MCP_AUTH_TOKEN not configured` from 24 August.
- **ROOT CAUSE:** Health writer accepts public `/health` as healthy when authenticated list fails.
- **FIX:** Overall status cannot be `healthy` if authenticated `tools/list` fails. Rewrite the row on every deploy probe.
- **COMPONENTS:** `control-plane.ts` health check
- **TEST:** Unset token in a dry environment → status degraded.
- **DONE:** Live D1 health matches live auth.

#### P1.2 Document lifecycle states

- **PROBLEM:** Stored ≠ indexed ≠ searchable.
- **ROOT CAUSE:** Event types are not a single document state machine.
- **FIX:** Explicit states RECEIVED → STORED → PARSING → INDEXING → READY / FAILED. READY requires search+fetch proof.
- **COMPONENTS:** `knowledge-ingestion-events.ts`, intake, company-knowledge-index
- **TEST:** PDF, DOCX, XLSX, TXT, small, larger, unusual name, re-upload.
- **DONE:** READY documents are retrievable.

#### P1.3 Hybrid retrieval without phrase lists

- **PROBLEM:** CIS, misspellings, conceptual PO questions fail.
- **ROOT CAUSE:** Lexical-only local search + empty Worker index + missing source docs.
- **FIX:** Hybrid lexical + semantic over the one index; neighbouring chunks; fetch expansion. Ingest the real PO / CIS documents if the business has them — do not invent synonyms for missing text.
- **COMPONENTS:** knowledge index, embeddings (Workers AI embeddings if used — do not add OpenAI as a new production dependency)
- **TEST:** Level 3 bank.
- **DONE:** Missing corpus returns `KNOWLEDGE_NO_MATCH`, not a wrong adjacent process.

#### P1.4 Observability trace

- **PROBLEM:** WhatsApp failures still require guesswork.
- **ROOT CAUSE:** IDs exist but are not one operator view.
- **FIX:** One trace record per user message: channel, user, tenant, model, tools available, model decision, tool, redacted params, MCP result, source status, next decision, final response, timing, errors.
- **COMPONENTS:** `orchestrator.ts`, `failure-telemetry.ts`, WhatsApp / Portal writers
- **TEST:** One Portal turn produces one readable trace.
- **DONE:** A failed WhatsApp question can be diagnosed from one id.

#### P1.5 Post-deploy EL capability gate

- **PROBLEM:** Deploy success ≠ capability health.
- **ROOT CAUSE:** No EL-specific probe in the deploy path; existing probe is Caddington + chatgpt identity.
- **FIX:** Level 1–2 automated job against `co_el` after every api/web/EL-MCP deploy.
- **COMPONENTS:** new EL probe (adapt `probe-mcp-acceptance.mjs`), CI / operator runbook
- **TEST:** Gate goes red if `xero_sales_summary` or `tools/list` fails.
- **DONE:** A broken authenticator cannot ship as a healthy deploy.

### P2 — Capability expansion

- General Xero read set (fix organisation; add bills, credit notes, bank summary if scopes already granted).
- Safe Action Engine writes with INFRA-TEST artefacts and mandatory read-back.
- Microsoft file search that shares the knowledge index.
- Calendar only if product-needed, behind RBAC.
- Do not implement BigChange / Commusoft until there is a real connector, not a catalogue card.

### P3 — Optimisation

- Remove Sharon / PO topic / WhatsApp finance regex once the agent loop + traces prove they are unused.
- Reduce deterministic Cloudflare path as tenants move to the real agent loop.
- Recipe store remains a hint, never a phrase router.
- Model provider stays as deployed; assess Llama-4 Scout only as fallback quality, do not switch EL off OpenAI in this programme unless asked.

---

## Definition of success (this programme)

Not that these exact prompts work:

- “How do I raise a PO?”
- “Show outstanding invoices.”
- “Find Michael’s email.”

Success is:

One EL Business MCP capability layer.

One INFRA conversational layer.

Multiple interchangeable clients.

A user can phrase a legitimate business request in many natural ways. The model understands it, discovers the company capability, calls allowed tools, retrieves authoritative evidence, performs only authorised actions, and answers from that evidence.

Until P0.1–P0.4 are done, do not spend the next iteration on isolated WhatsApp wording, ChatGPT MCP client quirks, or another single UAT sentence.

---

## Appendix — production facts captured this run

| Fact | Value |
|---|---|
| API SHA | `3a46485b1a87e438acd6bf6ce897053ec3d54466` |
| API branch | `cursor/el-portal-uat-repair-8d24` |
| EL MCP version | 1.2.0 |
| EL MCP endpoint | `https://el-business-mcp.daniel-dwyer123.workers.dev/mcp` |
| Facade tools advertised | 69 |
| EL local knowledge docs | 47 / 292 chunks |
| Worker knowledge docs | 0 |
| Worker microsoft_index_items | 501 |
| EL credential_refs | 0 |
| Xero tenant | `ec69a5fb-1b91-4cb5-a7f5-704dcecc5d2d` |
| Live Sep 2026 sales (Xero) | £5,094 |
| Warehouse last sync | 2026-09-05T11:00:11Z |
| Warehouse next slot | 2026-09-06T12:00 Europe/London |
| OpenAI brain companies | `co_el`, `co_caddington` |
| WhatsApp webhook | `https://api.infrastack.app/api/webhooks/whatsapp` |
