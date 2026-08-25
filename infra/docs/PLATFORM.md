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

Credential submission is disabled. `SecretProvider` is the only storage interface (ADR 019). OAuth state uses hashed state + PKCE; Xero is not activated (ADR 021).

`POST /api/mcp-environments/:id/refresh-capabilities` refreshes tools via `tools/list` + `system_health` + optional `database_summary`. It does **not** run knowledge search and is not billable.

## Health checks

`/health` and `/ready` and MCP `system_health` are **not billable**. Connector health and capability refresh are not billable.

## Secrets on `infra-api` (names only)

Required for Caddington: `CADDINGTON_MCP_AUTH_TOKEN`, `SESSION_SECRET`.

Required for HT / EL routing: `HT_MCP_AUTH_TOKEN`, `EL_MCP_AUTH_TOKEN` (same values as each Worker’s existing `MCP_AUTH_TOKEN` — do not rotate).

Stripe later: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
