# INFRA project status — accepted milestones

**Last updated:** 2026-08-28  
**Purpose:** Single consolidated record of accepted production milestones. Read this before starting new backlog work.

---

## Current summary

| Milestone | Status |
| --- | --- |
| **Automation Engine V1** | DONE — PASS |
| **Backlog Sprint 1** — Connector Productisation | DONE |
| **Backlog Sprint 2** — Microsoft 365 Self-Service | ENGINEERING COMPLETE — **PARTIAL** (pending Entra + live second-tenant acceptance) |
| **CMD16C** — Outlook shared mailbox + knowledge alpha | DONE — PASS |
| **Backlog Sprint 3** | **NOT STARTED** |

**Active human blocker:** Daniel — platform_multitenant Entra configuration + second-tenant onboarding test (Sprint 2). See [Microsoft 365 knowledge onboarding runbook](./runbooks/microsoft-365-knowledge-onboarding.md).

**Do not:** restart Sprint 2 implementation, duplicate Sprint 2 work, start Sprint 3, alter production Microsoft permissions, or modify Outlook RBAC during unrelated backlog work.

---

## 1. Automation Engine V1

| Field | Value |
| --- | --- |
| **Status** | DONE — PASS |
| **PR** | [#328](https://github.com/daniel00123-tech/Main/pull/328) |
| **Commit** | `1a9971bc494be32c86edfd41e726ddd453dfc9c5` |
| **Notes** | Production end-to-end execution accepted |

---

## 2. Backlog Sprint 1 — Connector Productisation Framework

| Field | Value |
| --- | --- |
| **Status** | DONE |
| **PR** | [#329](https://github.com/daniel00123-tech/Main/pull/329) |
| **Commit** | `6ec9861` |

---

## 3. Backlog Sprint 2 — Microsoft 365 Self-Service Onboarding

| Field | Value |
| --- | --- |
| **Status** | ENGINEERING COMPLETE — **ACCEPTANCE PARTIAL** |
| **Classification** | MICROSOFT 365 SELF-SERVICE: **PARTIAL** |
| **Branch** | `cursor/infra-m365-self-service-d3d8` |
| **Commit** | `018c742` |
| **PR** | [#330](https://github.com/daniel00123-tech/Main/pull/330) |
| **API deploy** | `4692396e-a007-4302-b633-a7445925cf18` |
| **Portal deploy** | `37873fe6` |
| **D1 migration** | `0032_microsoft_self_service.sql` (applied) |
| **Tests** | 410 API tests passing |

### Implemented

- `platform_legacy`, `company_app` (BYO), `platform_multitenant` (SaaS) auth modes
- Admin-consent OAuth, encrypted BYO credentials, Microsoft tenant binding
- SharePoint / OneDrive discovery, source/resource selection
- Company-scoped token resolution, health testing, reconnect/disconnect
- Portal onboarding wizard, audit, OAuth security controls, tenant-isolation tests
- Caddington `platform_legacy` production path **protected**

### Why PARTIAL (not PASS)

- `platform_multitenant` requires manual Microsoft Entra configuration by Daniel
- Genuine second-company / second-tenant live onboarding **not yet demonstrated**

**Do not mark Sprint 2 PASS until both are complete.**

Detailed report: `infra/docs/microsoft-365-self-service-report.md` (Sprint 2 branch).

Runbook: [Microsoft 365 knowledge onboarding](./runbooks/microsoft-365-knowledge-onboarding.md).

---

## 4. CMD16C — Outlook shared mailbox read + knowledge alpha

| Field | Value |
| --- | --- |
| **Status** | DONE — PASS |
| **Classification** | OUTLOOK SHARED MAILBOX READ + KNOWLEDGE ALPHA PASS |
| **Acceptance date** | 2026-08-28 |
| **Branch** | `cursor/infra-cmd16c-outlook-search-d3d8` |
| **Commit** | `d20583f` |
| **PR** | [#331](https://github.com/daniel00123-tech/Main/pull/331) |
| **API deploy** | `5c6d41f5-88c3-4c18-8543-09b19e477e0c` |
| **Tests** | 383 passed, 2 skipped (385 total) |

### Security (Caddington acceptance)

| Check | Result |
| --- | --- |
| Approved mailbox `admin@CaddingtonHoldings.co.uk` | Graph HTTP **200** — PASS |
| Denied mailbox `Daniel.Dwyer@CaddingtonHoldings.co.uk` | Graph HTTP **403** ErrorAccessDenied — PASS |
| Exchange Application RBAC | `Application Mail.Read` |
| Scope | `INFRA Approved Mailboxes Scope` |
| Exchange authorization | admin `InScope=True`, Daniel `InScope=False` |
| Broad Entra Graph Mail.Read | Removed **after** scoped RBAC proven |

### Knowledge acceptance

| Item | Result |
| --- | --- |
| `67567` → doc 68 | Indexed + searchable |
| `889` → doc 67 | Indexed + searchable |
| `123` → doc 69 | Indexed + searchable |
| Message `Test1` → doc 70 | Indexed + searchable |
| Attachment `Investment opportunity - Arnold Crescent.pdf` → doc 71 | discovered / stored / indexed / searchable — PASS |
| Message search | PASS |
| Idempotency | PASS |
| Tenant isolation | PASS |
| Queue processing | PASS |
| Graph subscription | Active (renewal path verified) |

### CMD16C search fix (root cause)

CMD16B reported 0 search hits because acceptance used Worker self-fetch gateway + mailbox-address semantic query. Production index was always working. Fix: direct MCP `search_company_knowledge` with subject/filename queries.

### CMD16C freeze

CMD16C is an **accepted production alpha baseline**. Do not modify during unrelated backlog work. See ADR 031 and [Outlook runbook](./runbooks/outlook-mailbox-onboarding.md).

---

## 5. Architecture decisions

| ADR | Title |
| --- | --- |
| [031](./adr/031-scoped-outlook-application-access-via-exchange-rbac.md) | Scoped Outlook application access via Exchange RBAC — **Accepted** |

Key principle: **two security boundaries** — Microsoft/Exchange authorization **and** INFRA tenant/source authorization. INFRA DB filtering is not a substitute for Exchange RBAC.

---

## 6. Microsoft architecture distinction (mandatory)

| | Knowledge onboarding (Sprint 2) | Outlook mailbox (CMD16C) |
| --- | --- | --- |
| **Sources** | SharePoint, OneDrive | Approved shared mailboxes |
| **Auth** | OAuth admin consent | Exchange Application RBAC |
| **Graph permissions** | Files.Read.All, Sites.Read.All, User.Read.All | Mail.Read (scoped via Exchange) |
| **Mail.Read in Sprint 2** | **NO** | N/A |

Do not merge these security models because both use Microsoft Graph.

---

## 7. Exchange operator discovery (permanent record)

`New-ManagementRoleAssignment` failed when `-App` used the Entra Application/Client ID. Successful Caddington assignment used the Exchange service principal **ObjectId** as `-Identity`.

Acceptance evidence only (do not hard-code in application logic):

| Item | Caddington value |
| --- | --- |
| Application (client) ID | `e5fd0533-ce51-43b8-999c-152f1e268246` |
| Exchange SP ObjectId | `a52f8dc5-c3ae-4e9a-8ad8-0f7526d46059` |

Documented in ADR 031 and [Outlook runbook](./runbooks/outlook-mailbox-onboarding.md).

---

## 8. Sprint 3

**NOT STARTED.** Do not begin until explicitly directed.

---

## Document index

| Document | Purpose |
| --- | --- |
| [PROJECT-STATUS.md](./PROJECT-STATUS.md) | This file — milestone consolidation |
| [ADR 031](./adr/031-scoped-outlook-application-access-via-exchange-rbac.md) | Outlook security architecture |
| [Outlook mailbox onboarding runbook](./runbooks/outlook-mailbox-onboarding.md) | Operator steps for Outlook |
| [Microsoft 365 knowledge onboarding runbook](./runbooks/microsoft-365-knowledge-onboarding.md) | Sprint 2 SharePoint/OneDrive + hold status |
| [PLATFORM.md](./PLATFORM.md) | Platform map for developers |
