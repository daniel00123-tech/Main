# ADR 012 — Connector framework

- **Status:** Accepted
- **Date:** 2026-08-25
- **Depends on:** ADR 001, ADR 010

---

## Decision

Connectors are **catalogue definitions + per-company instances**.

Catalogue (shared): type, name, description, icon, auth method, capabilities, read/write, config/credential schema, MCP requirement, setup instructions, availability (`available_now` / `requires_setup` / `coming_soon`).

Instance lifecycle:

`available` → `not_configured` → `configuring` → `connected` → `degraded` / `auth_expired` / `error` → `disconnected`

Operational data and sync live on the **company Business MCP**. INFRA stores control-plane metadata only.

Credential submission is **disabled** until a secure secret store is chosen. Schema and UI exist; values are not posted.

Do not implement live Xero / WhatsApp / BigChange / Commusoft APIs in this phase.

Google Drive on Caddington remains: Google Drive → Caddington MCP → INFRA metadata view.
