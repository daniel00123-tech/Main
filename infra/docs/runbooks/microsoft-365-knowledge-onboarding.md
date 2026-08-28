# Microsoft 365 knowledge onboarding (SharePoint / OneDrive)

Self-service onboarding for **SharePoint and OneDrive** knowledge sources. This is **Backlog Sprint 2** — distinct from [Outlook mailbox onboarding](./outlook-mailbox-onboarding.md) (CMD16C / Exchange Application RBAC).

**Do not add `Mail.Read` to this flow.**

---

## Architecture distinction

| Track | Products | Security model | Status |
| --- | --- | --- | --- |
| **Microsoft 365 knowledge onboarding** (this runbook) | SharePoint, OneDrive | OAuth admin consent; `Files.Read.All`, `Sites.Read.All`, `User.Read.All` | Sprint 2 — engineering complete, acceptance partial |
| **Microsoft Outlook mailbox onboarding** | Approved shared mailboxes | Exchange Application RBAC + INFRA source inclusion | CMD16C — PASS |

Both use Microsoft Graph but **must not share permission or onboarding assumptions**.

---

## Auth modes (Sprint 2)

| Mode | Use case | Notes |
| --- | --- | --- |
| `platform_legacy` | Existing Caddington tenant | Worker secrets; **protected** — do not break |
| `company_app` | BYO Entra app | Encrypted credentials + admin consent |
| `platform_multitenant` | INFRA SaaS app | Per-company admin consent; **requires manual Entra config** |

Implementation: PR #330, branch `cursor/infra-m365-self-service-d3d8`, commit `018c742`.

Full Sprint 2 report: `infra/docs/microsoft-365-self-service-report.md` (on Sprint 2 branch).

---

## Sprint 2 — held pending human action

Sprint 2 is **intentionally held**. Do not restart implementation. Do not start Sprint 3.

Daniel must complete **platform_multitenant** Entra configuration manually:

| Setting | Value |
| --- | --- |
| Supported account types | Accounts in any organizational directory |
| Redirect URI | `https://infra-api.daniel-dwyer123.workers.dev/api/connectors/microsoft/oauth/callback` |
| Application permissions | `Files.Read.All`, `Sites.Read.All`, `User.Read.All` |
| **Do not add** | `Mail.Read` |
| Publisher verification | Recommended — assess launch requirement |
| Worker flag (after Entra ready) | `MICROSOFT_MULTITENANT_APP=true` |

**PASS criteria not yet met:** genuine second-company / second-tenant live onboarding demonstration.

**Classification:** MICROSOFT 365 SELF-SERVICE: **PARTIAL**

---

## Operator checklist (when Entra is ready)

1. Complete Entra app registration settings above.
2. Set `MICROSOFT_MULTITENANT_APP=true` on `infra-api` Worker.
3. Connect second company via portal onboarding wizard.
4. Verify SharePoint and/or OneDrive discovery, source selection, sync, and knowledge search.
5. Confirm Caddington `platform_legacy` path unchanged.
6. Update [PROJECT-STATUS](../PROJECT-STATUS.md) classification to PASS when demonstrated.

---

## Related documents

- [Outlook mailbox onboarding](./outlook-mailbox-onboarding.md)
- [ADR 031 — Scoped Outlook application access](../adr/031-scoped-outlook-application-access-via-exchange-rbac.md)
- [PROJECT-STATUS](../PROJECT-STATUS.md)
