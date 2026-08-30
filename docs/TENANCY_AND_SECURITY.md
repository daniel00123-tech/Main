# Tenancy and security

Read this before changing auth, gateway, connectors, WhatsApp identity, billing, or Action Engine paths.

## Company / tenant scoping

A **company** is the tenant. IDs look like `co_caddington`. Slugs are unique (`caddington-holdings`).

Control-plane rows that carry customer meaning must include `company_id` (or be reached only through a company-scoped parent). Gateway, WhatsApp, automations, economics, and quality scoring all assert company scope.

Do not leak another company’s MCP tools, knowledge hits, credentials, wallet, or WhatsApp history.

Lifecycle (ADR 008): draft → provisioning → onboarding → active → suspended → archived → closed.

Gateway allows `active` and `onboarding` only.

Creating a company (`POST /api/companies`, platform admin) does **not** create a Cloudflare Worker.

## User membership

Tables: `users`, `memberships`.

A user may belong to multiple companies with a **company role** on each membership:

`engineer`, `junior_office`, `office_staff`, `supervisor`, `manager`, `director`, `company_admin`.

Session: cookie `infra_session` (HS256 JWT, 12h, `SESSION_SECRET`).

- Canonical portal: **host-only** cookie on `app.infrastack.app`
- Legacy: `Domain=.infra-web.pages.dev` only when the request host is that Pages domain
- Never `Domain=.infrastack.app`

AI clients do not use the cookie. They use per-company **service identities** (hashed bearer tokens) on `/api/gateway/v1/mcp`.

## Permission enforcement

`evaluateActionPermission` (`infra/packages/api/src/permissions/service.ts`):

1. Platform admin → allowed (still company-scoped in data access; do not skip `company_id` filters)
2. Membership must exist and be active
3. Role preset from `@infra/shared` + per-company `role_action_grants` / custom roles

Tool allowlists further restrict MCP `tools/call`.

Customer-facing errors must not name another tenant or dump raw provider payloads.

## Connector scoping

Catalogue definitions are global (`@infra/shared` catalogue). **Instances** are per company (ADR 018).

Credentials:

- `SecretProvider` is the only storage interface (ADR 019 / 026)
- Production: AES-256-GCM envelopes in D1, wrapping key `INFRA_CREDENTIAL_WRAPPING_KEY` (Worker secret, never in D1/Git/UI)
- Frontend, API JSON, audit, and logs never receive stored plaintext
- Google Drive credentials stay on the **company MCP**, not INFRA D1

OAuth app secrets (`XERO_*`, `MICROSOFT_*`) are Worker secrets. Per-company tokens are envelopes.

## Knowledge isolation

Knowledge search/fetch always runs as the authenticated company MCP. The gateway `search` / `fetch` adaptors reuse that MCP’s tools. No cross-tenant index.

OCR metadata may live on control-plane jobs; document bytes stay on the company MCP (Caddington R2 + Vectorize).

## WhatsApp identity resolution

`resolveWhatsAppIdentity` maps E.164 sender → user (`users.mobile`) → active memberships.

- Unknown or inactive number: public message only — **no tenant names, no tools**
- New users require E.164; existing users without a number stay usable and may be flagged `mobile_verification_required`
- Verification SMS is **not** enabled
- Cursor is not in the path
- Downstream MCP tokens never appear in WhatsApp messages

If a user has multiple memberships, the brain asks them to pick a company.

## Admin / super-admin boundaries

`users.is_platform_admin` → `SessionUser.isPlatformAdmin`.

Platform admin:

- Sees the control panel (`/`)
- Can create companies, view economics/quality/interactions
- Gets implicit `company_admin` when opening a company portal
- Must still not write another tenant’s data “because admin”

Company admin manages that company’s users, connectors, automations, and Action Engine approvals — not other companies.

## Protected writes and approvals

Financial / write risk classes require the **Action Engine** (ADR 029):

`plan → confirm → approve → execute` with idempotency keys, fingerprints, and stale-state protection.

| Gate | Current code |
| --- | --- |
| `FINANCIAL_WRITES_ENABLED` | `true` in `approvals.ts` — Action Engine may execute after approval |
| `DIRECT_MCP_FINANCIAL_WRITES_BLOCKED` | `true` — gateway rejects direct `xero_create_*` |
| Shared default `writesEnabled` | `false` in `@infra/shared` write-flags (safe default for callers that use the shared struct) |

WhatsApp write-looking intents are blocked in the planner (`blockWriteIntents`) and answered with a “use the portal Actions flow” message. Quality-loop patches cannot disable that block.

Suspended companies cannot execute writes.

## Other invariants

- Missing provider cost is **unavailable**, not £0
- `/health`, `/ready`, MCP `system_health`, connector health, and capability refresh are not billable
- Never commit secrets or `vendor/base.worker.js`
- Tenant spoof headers/ids on the gateway are detected and rejected
