# Outlook shared mailbox onboarding and security runbook

Operational steps to onboard **approved shared mailboxes** for Outlook knowledge ingestion. This runbook is **separate** from [Microsoft 365 knowledge onboarding](./microsoft-365-knowledge-onboarding.md) (SharePoint / OneDrive — Backlog Sprint 2).

**Architecture:** ADR 031 — Scoped Outlook application access via Exchange RBAC.

**Do not** add `Mail.Read` to Sprint 2 platform-multitenant or SharePoint/OneDrive OAuth flows.

---

## Prerequisites

- Exchange Administrator access (Exchange Online PowerShell)
- Entra Global Administrator or Application Administrator (app registration + admin consent)
- INFRA platform administrator (connector instance, source inclusion)
- Approved shared mailbox address(es) identified by customer
- Mail-enabled **security group** for approved mailboxes (not a distribution list used only for email)

---

## Security model summary

Two independent boundaries must both allow access:

1. **Microsoft / Exchange** — Application RBAC limits which mailboxes Graph can read.
2. **INFRA** — `microsoft_connector_sources` with `source_type=outlook_shared` and `inclusion_status=included` for the company.

INFRA filtering alone is **not** sufficient. Exchange scoping alone is **not** sufficient for multi-tenant INFRA.

---

## Phase 1 — Entra application

1. Use the tenant's INFRA Microsoft 365 Connector app registration (or create a dedicated app if policy requires).
2. Add Microsoft Graph **Application** permission: `Mail.Read`.
3. Grant **admin consent** for the tenant.

> **WARNING — DO NOT REMOVE BROAD ENTRA MAIL.READ UNTIL SCOPED EXCHANGE RBAC HAS BEEN CREATED AND VERIFIED.**
>
> Removing Entra `Mail.Read` before Exchange scope is working will break all mail access. The correct sequence is: grant → scope in Exchange → verify Graph 200/403 → then remove any redundant broad permission only if policy requires it after proof.

Optional for mailbox discovery (not a substitute for RBAC): `User.Read.All` (Application).

Record (do not paste secrets in tickets):

- Application (client) ID
- Service principal **Object ID** (Entra → Enterprise applications → app → Object ID)

---

## Phase 2 — Exchange service principal pointer

Connect to Exchange Online:

```powershell
Connect-ExchangeOnline
```

Register the Exchange service principal pointer (once per tenant):

```powershell
New-ServicePrincipal `
  -AppId <ENTRA_APPLICATION_CLIENT_ID> `
  -ObjectId <ENTRA_SERVICE_PRINCIPAL_OBJECT_ID> `
  -DisplayName "INFRA Microsoft 365 Connector"
```

---

## Phase 3 — Approved-mailbox security group

1. Create or identify a **mail-enabled security group** (e.g. `INFRA Approved Mailboxes`).
2. Add **only** approved shared mailbox identities as members (direct membership).
3. Do **not** add personal/user mailboxes used for negative testing.

Verify membership before scoping RBAC.

---

## Phase 4 — Exchange management scope

Create a management scope limited to group members:

```powershell
$group = Get-DistributionGroup -Identity "<Approved Mailboxes Group Name>"
New-ManagementScope `
  -Name "INFRA Approved Mailboxes Scope" `
  -RecipientRestrictionFilter "MemberOfGroup -eq '$($group.DistinguishedName)'"
```

---

## Phase 5 — Scoped Application Mail.Read assignment

Assign `Application Mail.Read` with the custom scope.

### Critical operator discovery (Caddington acceptance, 2026-08-28)

`New-ManagementRoleAssignment` **failed** when `-App` was supplied with the Entra **Application / Client ID**.

The **successful** assignment used the Exchange **service principal ObjectId** as `-Identity`:

```powershell
# Preferred — use Exchange service principal ObjectId
New-ManagementRoleAssignment `
  -Identity <EXCHANGE_SERVICE_PRINCIPAL_OBJECT_ID> `
  -Role "Application Mail.Read" `
  -CustomResourceScope "INFRA Approved Mailboxes Scope"
```

Alternative (verify in your tenant — may accept client ID on some builds):

```powershell
New-ManagementRoleAssignment `
  -App <ENTRA_APPLICATION_CLIENT_ID> `
  -Role "Application Mail.Read" `
  -CustomResourceScope "INFRA Approved Mailboxes Scope"
```

Or recipient group scope:

```powershell
New-ManagementRoleAssignment `
  -Identity <EXCHANGE_SERVICE_PRINCIPAL_OBJECT_ID> `
  -Role "Application Mail.Read" `
  -RecipientGroupScope "<Approved Mailboxes Group Name>"
```

Do **not** hard-code Caddington client or ObjectId values into INFRA application code. They may appear in acceptance evidence only.

---

## Phase 6 — Exchange authorization verification (mandatory)

**Real Graph 200/403 testing is mandatory before production Outlook ingestion.**

### Test-ServicePrincipalAuthorization (approved)

```powershell
Test-ServicePrincipalAuthorization `
  -Identity "<approved-mailbox@tenant>" `
  -Resource "<approved-mailbox@tenant>" `
  -Action Mail.Read
```

Expect: **InScope = True**

### Test-ServicePrincipalAuthorization (denied)

Use a mailbox **not** in the approved group (e.g. a personal mailbox reserved for negative testing):

```powershell
Test-ServicePrincipalAuthorization `
  -Identity "<denied-mailbox@tenant>" `
  -Resource "<denied-mailbox@tenant>" `
  -Action Mail.Read
```

Expect: **InScope = False**

### Graph API probes (mandatory)

Run live Graph probes against `/users/{mailbox}/messages`:

| Mailbox | Expected HTTP | Expected code |
| --- | --- | --- |
| Approved shared mailbox | **200** | Messages returned |
| Denied personal mailbox | **403** | `ErrorAccessDenied` |

INFRA acceptance (`run-cmd16b-outlook-rbac.mjs`) automates these probes. Do not skip manual verification on first tenant setup.

---

## Phase 7 — Broad Mail.Read removal (only after proof)

After scoped Exchange RBAC is proven (steps above + Graph 200/403):

- Entra broad `Mail.Read` tenant-wide grant may be removed **only if** Exchange RBAC alone enforces the intended scope and ops policy requires it.
- Caddington acceptance removed broad Entra `Mail.Read` after scoped RBAC was verified.

> **WARNING — DO NOT REMOVE BROAD ENTRA MAIL.READ UNTIL SCOPED EXCHANGE RBAC HAS BEEN CREATED AND VERIFIED.**

---

## Phase 8 — INFRA source inclusion

1. Ensure Microsoft 365 connector instance exists for the company.
2. Run Outlook mailbox discovery (Control Plane or API).
3. Set `inclusion_status=included` **only** for approved shared mailboxes.
4. Leave personal mailboxes **excluded** (default).

Verify `microsoft_connector_sources.source_type = outlook_shared` and company isolation on all queries.

---

## Phase 9 — Ingestion and knowledge

1. Trigger initial mailbox sync (or wait for scheduler).
2. Confirm messages appear in `microsoft_knowledge_items` with `indexing_status=indexed`.
3. Confirm attachments (PDF/DOCX/XLSX) are discovered, stored, extracted, and indexed.
4. Search via production Company Knowledge (`search_company_knowledge` / portal search):
   - Use **message subject** or attachment filename queries — not mailbox address as semantic content.
5. Run second sync — verify idempotency (no duplicate documents or queue jobs).

Acceptance reference (Caddington CMD16C):

| Query | Document |
| --- | --- |
| `67567` | 68 |
| `889` | 67 |
| `123` | 69 |
| `Test1` (message) | 70 |
| `Investment opportunity - Arnold Crescent` (attachment) | 71 |

---

## Phase 10 — Graph subscription and renewal

1. Ensure Graph change notification subscription exists for the included mailbox.
2. Verify subscription status `active` and expiry within renewal window.
3. Scheduler should renew before expiry; monitor `graphRenewals` errors.

Live notification delivery may not be observed on every acceptance run; reconciliation sync is the fallback. Do not disable subscriptions without operator approval.

---

## Phase 11 — Regression and freeze

CMD16C is the accepted production alpha baseline. After onboarding:

- Re-run `node infra/packages/api/scripts/run-cmd16b-outlook-rbac.mjs` when changing Outlook ingestion.
- Required PASS criteria: security (200/403), message search, attachment search (if attachments present), idempotency, queue, tenant isolation.
- Do not weaken negative mailbox testing or re-add broad Mail.Read during unrelated work.

---

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Graph 403 on approved mailbox | Group membership, management scope filter, role assignment identity (ObjectId vs Client ID) |
| Graph 200 on denied mailbox | RBAC scope too broad; remove mailbox from group; verify assignment scope |
| Messages ingested but search returns 0 | Search query (use subject not mailbox address); verify `search_company_knowledge` MCP path |
| Duplicate documents on resync | External IDs, idempotency keys, queue deduplication |
| `New-ManagementRoleAssignment` fails with `-App` | Use Exchange service principal ObjectId as `-Identity` |

---

## Related documents

- [ADR 031 — Scoped Outlook application access via Exchange RBAC](../adr/031-scoped-outlook-application-access-via-exchange-rbac.md)
- [Microsoft 365 knowledge onboarding](./microsoft-365-knowledge-onboarding.md) (SharePoint / OneDrive — Sprint 2)
- [PROJECT-STATUS](../PROJECT-STATUS.md)
