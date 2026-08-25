# ADR 013 — AI channel model

- **Status:** Accepted
- **Date:** 2026-08-25
- **Depends on:** ADR 001, ADR 006

---

## Decision

Requests do not assume ChatGPT. Every channel resolves to:

identity → company → permissions → interaction → usage → audit

Current / planned channels:

| Channel | Kind | Status |
| --- | --- | --- |
| ChatGPT | `chatgpt` | Live via INFRA MCP gateway |
| Claude | `claude` | Ready to connect via same gateway |
| WhatsApp | `whatsapp` | Designed, not activated (ADR 016) |
| Automation | `automation` | Future |
| Internal INFRA | `internal` | Admin / portal execute |

There is **one** public INFRA MCP URL:

`https://infra-api.daniel-dwyer123.workers.dev/api/gateway/v1/mcp`

Company routing comes from the authenticated service identity. Do not create `/caddington/mcp`, `/ht/mcp`, or `/el/mcp` as customer architecture.

Tokens are shown once. Downstream Business MCP credentials never appear in the UI.
