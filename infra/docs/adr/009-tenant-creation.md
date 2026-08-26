# ADR 009 — Tenant creation

- **Status:** Accepted
- **Date:** 2026-08-25
- **Depends on:** ADR 001, ADR 008

---

## Decision

Platform Admin creates companies through one reusable workflow.

Required: company name. Slug is suggested from the name, editable, then validated for:

- format (`^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$`)
- reserved platform words (`admin`, `portal`, `mcp`, …)
- uniqueness (explicit slug collisions are rejected; auto-generated slugs may suffix)

On success INFRA creates only INFRA-side foundation:

- company record + portal slug
- company configuration / modules
- wallet + ledger
- default **TEST credit** (1000p / £10) labelled `creditClass=test` when the caller does not override
- AI connection shells (ChatGPT / Claude / WhatsApp)
- payment-provider account row (`provider=stripe`, not configured)
- audit `company.created`

It does **not** create Cloudflare Workers, D1, R2, Vectorize, or pretend a Business MCP exists.

Caddington is a reference **configuration record**, not a special-case code path.
