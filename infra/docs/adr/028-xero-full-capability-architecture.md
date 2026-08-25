# ADR 028: Xero full-capability connector architecture

## Status

Accepted — 2026-08-25

## Context

ADR 027 delivered reusable Xero OAuth with initial read-only scopes. The production Xero Web App was created after Xero's granular-scope cutover (2 March 2026). INFRA must support full read + write **architecture** while keeping production financial writes disabled until explicitly approved.

## Decision

1. **Granular OAuth scopes** — Initial connect requests read-tier granular scopes only. Write scopes (`accounting.invoices`, `accounting.payments`, `accounting.contacts`) require deliberate admin scope upgrade + re-consent.

2. **INFRA permission boundary** — ChatGPT may request any supported tool. INFRA maps tool → action → permission → approval at execution time. No per-employee Xero OAuth integrations.

3. **Write activation gate** — `writesSupported = true`, `writesEnabled = false` in production until operator approval. Code paths exist; execution blocked.

4. **Execution plans** — Multi-step financial actions (batch credit notes, payment allocation) use reusable `execution_plans` with idempotency keys, per-item results, and partial-failure handling.

5. **Company MCP bridge** — Xero execution stays on Company Business MCP. INFRA provides OAuth, encrypted tokens, and internal `/api/internal/mcp/:mcpId/xero/context` for server-to-server credential resolution.

6. **Reusable `@infra/xero-core`** — Generic Xero API client + read/write tool implementations. Company MCPs install and configure; no copy-paste from Caddington-specific code.

## Consequences

- Caddington MCP must deploy xero-core handlers separately for ChatGPT to receive real Xero data.
- Scope upgrade UX in portal; reconnect when tokens lack required scopes.
- Financial writes require three gates: OAuth scopes, INFRA permission, production `FINANCIAL_WRITES_ENABLED`.

## Related

- ADR 001 (control plane boundary)
- ADR 027 (Xero OAuth)
- `@infra/shared` — `xero-scopes.ts`, `xero-actions.ts`, `xero-spec.ts`, `execution-plan.ts`
- `@infra/xero-core` — reusable execution module
