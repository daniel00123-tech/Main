# INFRA Phase 2 — Deployment Report

**Status:** Deployed to live INFRA only. Stopped for review (no Stripe / ChatGPT gateway / new connectors).

## What was implemented

1. **Generic connector architecture preserved** — catalogue definitions remain platform-wide; Caddington Google Drive is a company instance only. No BigChange/Commusoft/Xero connect flows.
2. **Caddington Company Portal** — live dashboard (connections, AI state, usage, recent activity), usage page from real `usage_records`, billing marked not configured, AI clients honestly “not via INFRA” / coming soon.
3. **Secure MCP auth path** — D1 stores `auth_secret_ref` / `service_binding_ref` only; Worker bindings hold secrets/fetchers. Credentials never in D1, frontend, or logs.
4. **Real MCP execution** — Platform Admin Test MCP on allowlisted read-only tools (`search_company_knowledge`, `system_health`, `database_summary`, `get_knowledge_document`).
5. **Usage metering** — every routed MCP execute writes a usage record (costs null).
6. **Audit** — `mcp.execution_requested` / `succeeded` / `failed`, health checks, permission denials; correlation IDs; no document bodies or secrets.
7. **Membership** — platform admin `daniel.dwyer123@gmail.com` also has Caddington `company_admin` membership.
8. **Tenant isolation** — company-scoped usage/overview APIs enforce membership server-side; automated tests cover isolation + allowlist + execute auth.

## Database migrations / schema

| Migration | Purpose |
|-----------|---------|
| `0004_mcp_execution_and_usage.sql` | Usage metering columns; `mcp_tool_allowlist`; MCP knowledge/latency fields |
| `0005_mcp_service_binding.sql` | `mcp_environments.service_binding_ref` |

Seed: `seed-phase2-caddington.sql` (allowlist, auth/service refs, membership, Drive status note).

## New secrets / bindings (names only)

| Name | Type | Notes |
|------|------|-------|
| `CADDINGTON_MCP_AUTH_TOKEN` | Optional Worker secret | Referenced by D1 `auth_secret_ref`; not set yet (MCP currently accepts unauthenticated calls) |
| `CADDINGTON_MCP` | Service binding → `caddington-mcp` | Required for same-account Worker→Worker (CF error 1042 on public workers.dev fetch) |
| `SESSION_SECRET` | Existing | Unchanged |

## Caddington Company Portal status

- Live at Company Portal after **re-login** (JWT must refresh to include membership).
- Connections reflect live MCP health / knowledge counts / Drive instance status.
- Usage shows real metering; billing clearly “not configured”.
- AI Connections: ChatGPT/Claude not connected via INFRA; WhatsApp coming soon.

## Caddington MCP authentication status

- Endpoint registered: `https://caddington-mcp.daniel-dwyer123.workers.dev/mcp`
- `auth_secret_ref = CADDINGTON_MCP_AUTH_TOKEN` (secret optional / unset → `authConfigured: false`)
- `service_binding_ref = CADDINGTON_MCP` (active)
- Health: **healthy**, MCP version **1.0.0**, **5 tools**, **46 documents / 124 chunks**

## Real MCP test performed and result

- Tool: `search_company_knowledge`
- Query: `What does the company annual leave policy say?`
- Result: **success** — hybrid search returned real Google Drive–sourced knowledge hits (e.g. HR/policy-related documents), correlation `corr_f35696f4-1467-4af2-81f4-79d9ed57f338`, ~26 ms.

## Usage record generated

- Success record: `usage_d01bd13d-1334-4d41-ba81-aa07163ea722`
- Summary after test: today 3 / month 3 / successful 1 / failed 2 (earlier binding/host failures retained for audit trail)
- Costs: `underlyingCostCents` / `customerChargeCents` = null

## Audit events generated

- `mcp.health_checked` (healthy)
- `mcp.execution_requested` / `mcp.execution_succeeded` with shared correlation ID
- Earlier failed attempts also audited (1042 / missing Host) before binding fix

## Tenant-isolation test results

- Unit/API tests: company usage denied cross-tenant; company user cannot execute MCP; non-allowlisted tools rejected; platform-admin execute + usage recording covered.
- Unauthenticated execute → 401 on live API.

## Tests / typecheck / build

- `npm test` — pass (API 32 + shared 12)
- `npm run typecheck` — pass
- `npm run build` — pass

## Live URLs

- Web: https://infra-web.pages.dev
- API: https://infra-api.daniel-dwyer123.workers.dev
- Caddington MCP (direct): https://caddington-mcp.daniel-dwyer123.workers.dev/mcp
- PR: https://github.com/daniel00123-tech/Main/pull/286

## Problems encountered

1. **CF 1042** — Worker cannot public-fetch another `*.workers.dev` Worker → fixed with service binding.
2. **Missing Host header** on service-binding fetch → Caddington MCP returned 403 → fixed by setting `Host` on the outbound Request.
3. Platform admin must **sign out and sign in again** to load Caddington membership into the session JWT.

## Anything still mocked / deferred

- Stripe, wallets, top-ups, customer charges, credit enforcement
- ChatGPT / Claude gateway routing (direct ChatGPT→Caddington MCP unchanged)
- WhatsApp, Cursor Bridge
- BigChange / Commusoft / Xero / SharePoint / OneDrive / Outlook / Freshdesk connectors
- Operational write connectors / complex approvals
- Underlying/supplier cost fields (intentionally null)

## Recommended next phase

1. Optional: enable MCP auth token (`CADDINGTON_MCP_AUTH_TOKEN`) when Caddington MCP requires Bearer auth.
2. Prove INFRA gateway path for one AI client (ChatGPT or Claude) **without** breaking the existing direct connection — behind feature flag if needed.
3. Only after metering is trusted in day-to-day use: Stripe wallet + customer pricing model.
4. First generic reusable connector connect-flow (definition → company instance credentials), starting with Google Drive or the next priority system.

**Do not proceed automatically into Stripe, ChatGPT routing, or new connectors until review.**
