# INFRA platform map (for future sessions)

Read this plus [ADR 001](./adr/001-company-mcp-vs-infra-boundary.md) before changing control-plane code.

INFRA is a **company-agnostic** multi-tenant control plane. Caddington, HT, and EL are the first three configuration records — not three applications. A fourth company is created from Platform Admin without new React routes, billing code, or permission code.

## Tenants (production configuration — not hardcoded product)

| Company | ID | Slug | Existing Business MCP | Notes |
| --- | --- | --- | --- | --- |
| Caddington Holdings | `co_caddington` | `caddington-holdings` | `caddington-mcp` | Reference tenant |
| HT Business | `co_ht` | `ht-business` | `ht-business-mcp` | Available, paused for deeper integration |
| EL Business | `co_el` | `el-business` | `el-business-mcp` | Available, paused for deeper integration |

Do **not** rebuild those MCPs. INFRA only registers and routes to them.

New companies start as `onboarding` with a wallet, TEST credit, AI connection shells, and a reusable portal. Business MCP is **not** provisioned automatically.

Company portals are one reusable app: `/portal/:companySlug/…`.

## Create Company

`POST /api/companies` (platform admin). Validates slug format / reserved words / uniqueness. Does not create Cloudflare Workers.

## Onboarding

`GET /api/companies/:slug/onboarding` and `overview.onboarding` are computed from live state. Do not show fake Connected.

## Boundary

```
Business systems → Company MCP (knowledge / warehouse / connectors)
                         ↓
                    INFRA API (identity, authz, routing, meter, wallet, audit)
                         ↓
                    ChatGPT / Claude
```

ChatGPT authenticates to INFRA. INFRA authenticates separately to the company MCP. Downstream tokens never appear in the UI.

The public INFRA MCP (`/api/gateway/v1/mcp`) advertises company tools plus, when the tenant has knowledge tools, standard read-only `search` and `fetch` adaptors so ChatGPT Company Knowledge / File Search can use the same corpus. `search` reuses `search_company_knowledge`; `fetch` reuses `get_knowledge_document`. Tenant isolation stays on the authenticated identity. After a tool-catalogue change, ChatGPT Workspace Settings must refresh/republish the app — ChatGPT stores a frozen snapshot.

## Metering & billing

- Three levels: interaction → tool operation → optional cost component (ADR 006).
- Granular `usage_records` + ledger debits remain authoritative (ADR 004).
- `interaction_id` groups one human turn only when correlation is defensible (ADR 002). ChatGPT does not currently send one, so search+read stay separate unless `X-Infra-Interaction-Id` is supplied.
- TEST prices stay 1p search / 1p read / health free (ADR 003, ADR 007).
- Missing provider cost is **unavailable**, not £0.
- Stripe is prepared, not live. 60% margin remains banked.

## Readiness

Capability-aware (ADR 017). Required: company, admin, MCP + auth, wallet. Knowledge / AI / Xero are optional unless `company.config.readiness` says otherwise. Caddington is the reference tenant, not a hardcoded special case.

## Connectors

Definitions live in shared catalogue. Instances are per-company (ADR 018). Auth, sync, and provider health are separate (ADR 022). ChatGPT is an AI connection, not a Drive-like data source.

`SecretProvider` is the only storage interface (ADR 019 / 026). Production uses AES-256-GCM ciphertext in D1 and `INFRA_CREDENTIAL_WRAPPING_KEY` as a Worker secret. If that key is missing, Save & Test stays disabled and the UI says storage is not configured. Frontend, API responses, audit, and logs never receive stored plaintext.

Xero OAuth is reusable for every company (ADR 027, ADR 028). Application credentials are Worker secrets `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET`. Per-company tokens are envelope-encrypted. Accounting data stays on Xero and the company Business MCP.

Initial OAuth uses **granular read scopes** (apps created after March 2026). Write scopes require admin scope upgrade + re-consent. Production financial writes stay disabled (`FINANCIAL_WRITES_ENABLED = false`) until operator approval.

Company MCP resolves Xero credentials via internal bridge `POST /api/internal/mcp/:mcpId/xero/context` (server-to-server only). Reusable execution logic lives in `@infra/xero-core`.

Multi-step financial actions use `execution_plans` (migrations 0015, 0016) with idempotency keys, confirmation tokens, plan fingerprints, and per-item targets. See **ADR 029** for the Action Engine (plan → confirm → approve → execute, stale-state protection, write feature flags). Production financial writes remain disabled (`FINANCIAL_WRITES_ENABLED = false`).

Company portal **Actions** page (`/portal/:slug/actions`) lists pending and completed action plans.

Future **company data warehouse** direction: ADR 030 (planning only — not built).

`POST /api/mcp-environments/:id/refresh-capabilities` refreshes tools via `tools/list` + `system_health` + optional `database_summary`. It does **not** run knowledge search and is not billable.

### Microsoft 365 — two distinct onboarding tracks

Do not merge these because both use Graph:

| Track | Sources | Security | Milestone |
| --- | --- | --- | --- |
| **Knowledge onboarding** | SharePoint, OneDrive | OAuth; `Files.Read.All`, `Sites.Read.All`, `User.Read.All` — **no Mail.Read** | Sprint 2 (PARTIAL — held for Entra) |
| **Outlook mailbox onboarding** | Approved shared mailboxes | Exchange Application RBAC + INFRA source inclusion | CMD16C (PASS — frozen baseline) |

See [PROJECT-STATUS](./PROJECT-STATUS.md), **ADR 031**, and runbooks [Microsoft 365 knowledge](./runbooks/microsoft-365-knowledge-onboarding.md) / [Outlook mailbox](./runbooks/outlook-mailbox-onboarding.md).

## Health checks

`/health` and `/ready` and MCP `system_health` are **not billable**. Connector health and capability refresh are not billable.

## Needs attention

Derived model (`GET /api/platform/attention`, `GET /api/companies/:slug/attention`): MCP offline, OAuth expired, low wallet, onboarding gaps, missing AI identity, Stripe not configured. Surfaces on Control Plane dashboard and company portal problems — not external notifications yet.

## Runbooks

Operational guides under [`docs/runbooks/`](./runbooks/):

- [PROJECT-STATUS](./PROJECT-STATUS.md) — accepted milestones (Automation Engine, Sprint 1–3, CMD16C)
- [New company onboarding](./runbooks/new-company-onboarding.md)
- [Microsoft 365 knowledge onboarding](./runbooks/microsoft-365-knowledge-onboarding.md) (SharePoint / OneDrive — Sprint 2)
- [Outlook mailbox onboarding](./runbooks/outlook-mailbox-onboarding.md) (Exchange RBAC — CMD16C)
- [MCP provisioning recommendation](./runbooks/mcp-provisioning-recommendation.md)
- [Backup & recovery review](./runbooks/backup-recovery-review.md)
- Incident: MCP offline, OAuth expired, AI token compromised, wallet, connector degraded, suspension, credential rotation, failed financial action, provider outage

## Public URLs

Configure per environment (not tenant-specific):

- `INFRA_PUBLIC_API_URL` — API Worker (e.g. `https://infra-api.<account>.workers.dev`)
- `PORTAL_BASE_DOMAIN` — Pages host for portal subdomains (e.g. `infra-web.pages.dev`)
- Web build: `VITE_API_BASE` optional override; dev uses Vite proxy

## Scale notes (conceptual)

| Tenants | First pressure |
| --- | --- |
| 3–10 | Manual MCP registration; admin dashboard MCP health polling |
| 10–100 | D1 company listing pagination; unbounded audit/usage lists; Worker secret count |
| 100–1000 | Per-tenant MCP provisioning automation; health probe fan-out; D1 export/backup |

Near-term mitigations: company search, attention API, pagination on list endpoints where added, derived readiness (no fake states).

## Secrets on `infra-api` (names only)

Required for Caddington: `CADDINGTON_MCP_AUTH_TOKEN`, `SESSION_SECRET`.

Required for HT / EL routing: `HT_MCP_AUTH_TOKEN`, `EL_MCP_AUTH_TOKEN` (same values as each Worker’s existing `MCP_AUTH_TOKEN` — do not rotate).

Stripe later: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.

Connector credential wrapping: `INFRA_CREDENTIAL_WRAPPING_KEY` and optional `INFRA_CREDENTIAL_KEY_VERSION` (currently `v1`). Never store these values in D1, Git, or the UI.

Xero application (set by an operator in Cloudflare, never in Git or chat): `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, optional `XERO_OAUTH_REDIRECT_URI`.
