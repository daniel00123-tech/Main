# ADR 025 — ChatGPT Company Knowledge adaptors

- **Status:** Accepted
- **Date:** 2026-08-25
- **Depends on:** ADR 001, ADR 023

## Decision

INFRA's public MCP facade exposes standard read-only tools named `search` and `fetch` so ChatGPT can treat the connection as a Company Knowledge / File Search source.

These tools are **adaptors**, not a second retrieval engine:

- `search` → the authenticated tenant's `search_company_knowledge`
- `fetch` → the authenticated tenant's `get_knowledge_document`

Do not rename or remove the existing company tools. Do not hard-code a tenant. Do not invent source URLs.

## Why INFRA, not the company MCP

ChatGPT connects to INFRA (`/api/gateway/v1/mcp`), not to Caddington/HT/EL directly. Company Knowledge eligibility is an input-signature check for tools named `search` (`query`) and `fetch` (`id`). Adding those names on the facade keeps auth, tenant isolation, metering, and audit on the control plane.

## Annotations

`search`, `fetch`, `search_company_knowledge`, `get_knowledge_document`, `system_health`, and `database_summary` are retrieval/health tools. They advertise `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.

## ChatGPT snapshot

ChatGPT Workspace Settings stores a frozen tool catalogue when an app is published. Deploying the Worker is not enough — an admin must refresh/recreate and republish the app before File Search eligibility appears.
