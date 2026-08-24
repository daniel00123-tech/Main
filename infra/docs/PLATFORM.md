# INFRA platform map (for future sessions)

Read this plus [ADR 001](./adr/001-company-mcp-vs-infra-boundary.md) before changing control-plane code.

## Tenants (production)

| Company | ID | Slug | Existing Business MCP |
| --- | --- | --- | --- |
| Caddington Holdings | `co_caddington` | `caddington-holdings` | `caddington-mcp` |
| HT Business | `co_ht` | `ht-business` | `ht-business-mcp` |
| EL Business | `co_el` | `el-business` | `el-business-mcp` |

Do **not** rebuild those MCPs. INFRA only registers and routes to them.

Company portals are one reusable app: `/portal/:companySlug/…`.

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

- Granular `usage_records` per tool call.
- `interaction_id` groups one human turn when the client supplies it (ADR 002).
- Ledger is the wallet source of truth (ADR 004).
- TEST prices stay 1p search / 1p read / health free (ADR 003).
- Stripe is prepared, not live.

## Health checks

`/health` and `/ready` and MCP `system_health` are **not billable**.

## Secrets on `infra-api` (names only)

Required for Caddington: `CADDINGTON_MCP_AUTH_TOKEN`, `SESSION_SECRET`.

Required for HT / EL routing: `HT_MCP_AUTH_TOKEN`, `EL_MCP_AUTH_TOKEN` (same values as each Worker’s existing `MCP_AUTH_TOKEN` — do not rotate).

Stripe later: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
