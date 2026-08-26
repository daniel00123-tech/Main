# ADR 008 — Company lifecycle

- **Status:** Accepted
- **Date:** 2026-08-25
- **Depends on:** ADR 001
- **Applies to:** companies, gateway admission, Platform Admin

---

## Decision

Company lifecycle is **server-authoritative**. UI never invents a status.

| Status | Meaning | Gateway paid ops |
| --- | --- | --- |
| `draft` | Incomplete record | Blocked |
| `provisioning` | Internal create in progress | Blocked |
| `onboarding` | INFRA foundation exists; Business MCP may be absent | Allowed if an MCP is later registered (TEST credit) |
| `active` | Production tenant | Allowed |
| `suspended` | Temporarily blocked; data retained | Blocked; service identities disabled |
| `archived` / `closed` | Terminal; data retained | Blocked |

New companies start as **`onboarding`**. Existing production tenants (Caddington, HT, EL) remain **`active`**.

Creating a company does **not** provision a Business MCP Worker. `mcp_onboarding_status` starts as `not_provisioned`.

Default currency is GBP where unspecified. The schema stores `currency` per company and must not assume GBP globally.
