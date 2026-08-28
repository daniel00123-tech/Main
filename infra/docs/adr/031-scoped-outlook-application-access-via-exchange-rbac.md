# ADR 031 — Scoped Outlook application access via Exchange RBAC

- **Status:** Accepted
- **Date:** 2026-08-28
- **Depends on:** ADR 012, ADR 018, ADR 022, ADR 023
- **Supersedes:** Broad tenant-wide Entra `Mail.Read` (Application) as a production security model
- **Related:** [Outlook mailbox onboarding runbook](../runbooks/outlook-mailbox-onboarding.md), [PROJECT-STATUS](../PROJECT-STATUS.md)

---

## Context

Microsoft Graph `Mail.Read` (Application) grants the INFRA app permission to read mail in **every** mailbox in a tenant unless Microsoft-side scope is applied. INFRA also maintains its own source inclusion allowlist in D1.

CMD16C (2026-08-28) proved production Outlook shared-mailbox ingestion for Caddington with:

- Exchange Application RBAC (`Application Mail.Read` + custom approved-mailbox scope)
- INFRA source inclusion for `outlook_shared` mailboxes
- Real Graph isolation: approved mailbox HTTP 200, denied personal mailbox HTTP 403
- Company Knowledge indexing and search for messages and attachments

Broad Entra Graph `Mail.Read` (Application) was **removed after** scoped Exchange RBAC was verified. That removal is intentional and must not be reversed without a dedicated security review.

---

## Decision

### Required production chain for Outlook ingestion

Outlook shared-mailbox ingestion **must** follow this chain:

```
Entra application registration
  → Exchange service principal pointer (New-ServicePrincipal)
  → Exchange Application RBAC
  → Application Mail.Read role assignment
  → custom approved-mailbox management scope
  → INFRA microsoft_connector_sources inclusion (outlook_shared)
  → sync / queue / attachment extraction
  → Company Knowledge indexing
```

Both Microsoft authorization **and** INFRA tenant/source authorization must permit access. Either boundary denying access must block ingestion.

### Two security boundaries (defence in depth)

| Boundary | Owner | What it controls |
| --- | --- | --- |
| **Microsoft / Exchange authorization** | Tenant Exchange administrator | Which mailboxes Graph may read for the app (RBAC scope, group membership) |
| **INFRA tenant / source authorization** | INFRA control plane | Which included sources INFRA will call Graph for (`company_id`, `inclusion_status`, connector instance) |

**INFRA database filtering must never be treated as a replacement for Microsoft-side mailbox authorization.**

If INFRA were misconfigured to include a mailbox, Exchange RBAC must still deny Graph access for mailboxes outside the approved scope.

### Entra vs Exchange responsibilities

| Layer | Permissions | Outlook mail |
| --- | --- | --- |
| **Entra app registration** | Application permissions granted + admin consent | `Mail.Read` (Application) only when Outlook is in scope for that tenant |
| **Exchange Online** | RBAC for Applications | `Application Mail.Read` scoped to approved mail-enabled security group |

Do **not** assume Entra permission removal alone secures Outlook. Do **not** assume Exchange scope alone secures multi-tenant INFRA — company and source rows remain mandatory.

### Distinction from Microsoft 365 knowledge onboarding (Sprint 2)

These are **separate** security models that both happen to use Microsoft Graph:

| Track | Scope | Auth model | Milestone |
| --- | --- | --- | --- |
| **Microsoft 365 knowledge onboarding** | SharePoint, OneDrive | OAuth admin consent; `Files.Read.All`, `Sites.Read.All`, `User.Read.All` | Backlog Sprint 2 |
| **Microsoft Outlook mailbox onboarding** | Approved shared mailboxes only | Exchange Application RBAC + INFRA source inclusion | CMD16C |

Do **not** merge these models. Sprint 2 self-service onboarding must **not** add `Mail.Read`. Outlook onboarding follows this ADR and the Outlook runbook only.

### CMD16C production alpha baseline (frozen)

CMD16C is an accepted production alpha baseline. Unrelated backlog work must **not**:

- Re-add broad Entra `Mail.Read`
- Broaden Exchange scope beyond approved mailboxes
- Include denied test mailboxes (e.g. personal mailboxes) in ingestion
- Weaken negative mailbox Graph testing
- Remove Microsoft-side authorization
- Casually refactor Outlook ingestion without dedicated regression testing

Future Outlook changes require security re-verification (Graph 200/403 probes) and CMD16 acceptance re-run.

### Operator evidence (Caddington acceptance — not reusable constants)

The following values document **acceptance evidence only**. Do **not** hard-code them into application logic.

| Item | Caddington acceptance value |
| --- | --- |
| Approved mailbox | `admin@CaddingtonHoldings.co.uk` |
| Denied test mailbox | `Daniel.Dwyer@CaddingtonHoldings.co.uk` |
| Entra application (client) ID | `e5fd0533-ce51-43b8-999c-152f1e268246` |
| Exchange service principal ObjectId | `a52f8dc5-c3ae-4e9a-8ad8-0f7526d46059` |
| Scope group | `INFRA Approved Mailboxes` / `infra-approved-mailboxes@CaddingtonHoldings.co.uk` |
| Management scope | `INFRA Approved Mailboxes Scope` |

Exchange authorization at acceptance: admin `InScope=True`, Daniel `InScope=False`.

---

## Consequences

- All new Outlook tenants require Exchange RBAC setup **before** production ingestion.
- Real Graph HTTP 200 (approved) and HTTP 403 (denied) probes are mandatory acceptance gates.
- Broad Entra `Mail.Read` must remain removed once scoped RBAC is proven.
- Acceptance scripts must search indexed **message content** (subjects, attachment names), not mailbox addresses as semantic queries.
- Production knowledge search uses `search_company_knowledge` via the registered company MCP path.

---

## References

- PR #331 — CMD16C search path fix + attachment acceptance
- PR #330 — Sprint 2 Microsoft 365 self-service (SharePoint/OneDrive only)
- [Outlook mailbox onboarding runbook](../runbooks/outlook-mailbox-onboarding.md)
