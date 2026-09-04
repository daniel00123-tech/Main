# INFRA Company MCP Standard

Status: accepted platform contract  
Audience: anyone adding a company MCP or connector to INFRA

This is the reusable contract. New company MCPs inherit the shared reasoning, evidence, quality, usage, and failure stack through registration. They must not fork an EL-only, Caddington-only, or HT-only brain.

## 1. Authentication contract

- Company MCP traffic enters through `infra-api` (Cloudflare control plane).
- Human ChatGPT / Claude use INFRA OAuth. Service callers use the registered MCP auth secret ref.
- Never store plaintext downstream tokens in D1. Only Worker secret binding names.
- Cursor is never on the synchronous customer path.

## 2. Company binding

Every request resolves:

1. identity  
2. company / tenant  
3. membership  
4. RBAC  
5. commercial eligibility  
6. allowed capability catalogue  

A tool from another tenant must never appear in this catalogue.

## 3. Health contract

The MCP (or its INFRA facade) exposes a health surface that reports:

- reachable / authenticated / degraded / offline
- connected connector ids only
- no advertised systems that are disconnected

## 4. Capability registry

Register business capabilities, not vendor quirks:

| Capability | Typical INFRA tools |
| --- | --- |
| EMAIL_SEARCH / EMAIL_LIST / EMAIL_READ | `outlook_search_mailbox`, `outlook_list_messages`, `outlook_get_message` |
| ACCOUNTING_SALES / INVOICE_* | `xero_sales_summary`, `xero_search_invoices`, `xero_get_invoice` |
| KNOWLEDGE_SEARCH / KNOWLEDGE_READ | `search_company_knowledge`, `get_knowledge_document` |
| CATALOGUE_LIST | `list_documents` |
| JOB_SEARCH | future BigChange / Commusoft mapping |
| WEB_PUBLIC | `web_search` |

A tenant sees a capability only when a connector is registered, connected, and role-safe.

## 5. Tool schemas

Every INFRA tool carries:

- `toolName`
- `capability`
- `companyScope` (tenant)
- `requiredPermission`
- `description` / when-to-use / when-not
- `inputSchema` / `outputShape`
- `readWrite`
- `billingAction`
- `timeoutMs`
- `idempotent`

Vendor names are normalised in the facade (`analyse_xero_sales` → `xero_sales_summary`). OpenAI reasons over INFRA names only.

## 6. Permission mapping

OpenAI does not decide permissions.

User request → tenant/member → allowed-tool catalogue → model may request a tool → authoritative second RBAC check → connector execution.

Writes stay forbidden on the conversational path unless an explicit controlled-action flow is used.

## 7. Connector health

Disconnected or unapproved systems must not be advertised. HT must not inherit EL Outlook/Xero tools. Caddington must not inherit EL-only catalogue entries it does not have.

## 8. Response normalisation

Every normal turn ends in one terminal:

- `ANSWER`
- `PERMISSION_DENIED`
- `NO_RESULTS`
- `UPSTREAM_FAILURE`
- `CLARIFICATION_REQUIRED`

The shared response quality guard runs for every tenant before the user sees an answer.

## 9. Evidence metadata

Evidence objects are tenant-stamped:

- `company_id`
- `source`
- permission context / tool name
- timestamp
- safe structured payload

Evidence never crosses `co_el` / `co_caddington` / `co_ht` / future tenants.

If authorised recent evidence already answers the ask (who sent this email, draft a reply, summarise these figures), do not call the connector again.

## 10. Usage / billing metadata

Parent row: `customer.request` when the tenant has an explicit request-level policy.

Children: OpenAI inference, Cloudflare inference, Xero, Outlook, knowledge, CRM, web.

- EL: 3p per genuine customer request. Children do not debit.
- Caddington / HT: existing tariff unchanged.
- Future companies: explicit commercial config. Do not inherit EL 3p.
- Automations, shadow, quality, health, tests: never customer-billed.

## 11. Failure semantics

Shared categories include `EXPECTED_TOOL_MISSING`, `WRONG_TOOL`, `WRONG_CAPABILITY`, `UPSTREAM_FAILURE`, `RBAC_DENIAL`, `EVIDENCE_DROPPED`, `SYNTHESIS_CONTRADICTION`, `FIRST_ANSWER_INCOMPLETE`, `DUPLICATE_TOOL`, `NO_FINAL_RESPONSE`, `FALLBACK_USED`, `QUALITY_GUARD_REPAIR`.

Every event includes `company_id`. Clusters are shared across tenants so one Outlook list/search fix helps every company.

No auto-deploy from a single customer failure.

## 11a. Daily self-improvement loop

New company MCPs inherit the platform daily improvement loop automatically. There is no per-business implementation.

Every genuine customer request on WhatsApp, Portal Chat, ChatGPT MCP, and future chat surfaces creates one canonical parent interaction (no secrets). At 16:30 Europe/London the Automation Engine evaluates interactions since the previous completed QA window. At 17:00 Europe/London INFRA emails the Daily Improvement Report to the existing Daniel admin recipient. The email is informational: no Approve, Confirm, or Deploy button. At 17:05 the engineering queue starts without waiting for confirmation.

Cursor / the dev supervisor stays off the customer path. Defects must be reproduced before a fix. Fixes must be generic. Each fix adds a permanent regression test. Shared-platform changes must prove EL, Caddington, HT, and future tenants stay isolated. QA, engineering, tests, and shadow carry 0 customer charge. Automatic deploy is allowed only after reproduction, local tests, regression, tenant isolation, billing safety, and the canonical deploy guard. Post-deploy failure rolls back automatically.

The loop must not weaken RBAC, rotate secrets, expand write permissions, change tenant pricing, or promote OpenAI `shadow → canary → primary`. The 08:00 Daily EL knowledge activity automation is a separate ingestion job and is not rescheduled by this loop.

## 12. OpenAI reasoning compatibility

The reasoning provider is a shared INFRA interface with per-tenant policy and a channel role:

- Roles: `pa` (Portal Chat), `request` (WhatsApp), `chatbot` (ChatGPT / MCP), `automation`, `internal`
- Modes: `cloudflare` (default for new companies), `openai_shadow`, `openai_canary`, `openai_primary`

On an allowlisted company (EL today), PA and request turns use OpenAI as the user-visible brain even when the global mode is `openai_shadow`. Unscoped / automation traffic stays shadow: Cloudflare answers, OpenAI evaluates in parallel. Caddington, HT, and future tenants stay Cloudflare until explicitly allowlisted.

Cloudflare remains authoritative for transport, auth, RBAC, secrets, connectors, D1, usage, billing, audit, rate limits, deploy, and fallback.

OpenAI (Responses API, Luna / Terra / Sol) plans, selects tools, interprets evidence, and synthesises for PA and requests. Workers AI remains the provider fallback for true provider failure only.

ChatGPT MCP stays a direct controlled-tool facade. Do not wrap ChatGPT in another model. The chatbot is not the INFRA-hosted brain.

## 13. Test requirements

A new MCP must have:

- auth / company binding tests
- catalogue isolation tests (no foreign tenant tools)
- RBAC second-check tests
- evidence isolation tests
- pricing isolation tests
- deploy-guard import of the shared superstack

EL is the reference validation tenant, not the only tenant that can use the stack.

## 14. Deployment requirements

One canonical `infra-api` superstack. Tenant feature branches must not last-deploy-wins over shared capabilities. `npm run deploy` fails if WhatsApp, OAuth, MCP, Portal Chat, OpenAI provider, Cloudflare provider, RBAC, usage, billing, automation, quality, daily improvement, tenant registry, tool registry, or failure telemetry is missing.

No new Worker. No secret rotation as part of MCP onboarding unless the connector itself requires a new secret ref.
