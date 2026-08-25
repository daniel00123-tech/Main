# ADR 010 — Business MCP onboarding

- **Status:** Accepted
- **Date:** 2026-08-25
- **Depends on:** ADR 001, ADR 008, ADR 009

---

## Decision

INFRA registers **existing** company MCPs. It does not create them in this phase.

Onboarding states (computed, not faked):

| State | Meaning |
| --- | --- |
| not_provisioned | No `mcp_environments` row |
| registered | Row exists; no successful authenticated call yet |
| authentication_required | Missing `auth_secret_ref` |
| connected | At least one successful request |
| healthy / degraded / offline | From last health / MCP status |

Registration stores:

- name, company, endpoint, versions, capabilities, `auth_secret_ref`, optional service binding

**Never** store plaintext downstream tokens in D1. Only Worker secret binding names.

Capability discovery is dynamic: INFRA reacts to reported tools (`system_health`, `database_summary`, `search_company_knowledge`, `get_knowledge_document`, …). Knowledge is **not** inferred from MCP health.
