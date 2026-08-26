# ADR 011 — Future automated Business MCP provisioning

- **Status:** Accepted (design only — not activated)
- **Date:** 2026-08-25
- **Depends on:** ADR 001, ADR 010

---

## Context

Eventually: Create Company → provision a standard Business MCP (isolated Worker, D1, optional R2 / Vectorize, company secrets) → register with INFRA → ready for connectors.

This phase **must not** mass-create Cloudflare resources.

---

## Target design

1. **Strict tenant isolation** — one Worker + one D1 per customer MCP. No shared customer credentials. No shared knowledge index.
2. **Least privilege** — INFRA holds only a secret *reference* to the downstream token.
3. **Lazy resources** — Vectorize / R2 only when knowledge is requested.
4. **Cost control** — do not pre-create idle Vectorize indexes.
5. **Repeatability** — versioned Business MCP Core image / Worker template.
6. **Safe upgrades** — pin `mcp_version` + `business_mcp_core_version`; roll forward one tenant at a time; keep previous Worker version for rollback.
7. **Registration** — after provision, write the same `mcp_environments` row used for existing MCPs.

Activation requires explicit owner approval and Cloudflare account credentials beyond this environment.
