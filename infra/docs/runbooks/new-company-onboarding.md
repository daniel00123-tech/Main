# New company onboarding runbook

Operational steps to take a tenant from **created** to **active**. No secret values belong in this document.

## Prerequisites

- Platform administrator access to INFRA Control Plane
- A deployed **Business MCP Worker** for the customer (INFRA does not auto-provision MCPs in this phase — see [MCP provisioning recommendation](./runbooks/mcp-provisioning-recommendation.md))
- Worker secret for downstream MCP auth (stored as Cloudflare Worker secret, referenced by name only in D1)

## 1. Create company

1. Control Plane → **Companies** → **Add company**
2. Enter legal/trading name (e.g. *ABC Plumbing Ltd*). Slug is derived; confirm availability.
3. Set primary admin email and optional TEST wallet credit.
4. Submit. Record:
   - Company ID (`co_…`)
   - Slug (`abc-plumbing-ltd`)
   - Portal path `/portal/{slug}/dashboard`

**Verify:** company status is `onboarding`; wallet row exists; no MCP row yet; no phantom MCP created.

## 2. Register Business MCP

1. Deploy or identify the customer's Business MCP Worker (isolated per ADR 001).
2. Control Plane → company detail → **Register existing MCP** (or `POST /api/mcp-environments`)
3. Provide: name, endpoint URL (`…/mcp`), `authSecretRef` (Worker secret name — not the token value).

**Verify:** MCP appears on company detail; health check reachable; capabilities refresh succeeds.

## 3. Credential storage

1. Ensure `authSecretRef` secret exists on `infra-api` Worker (or customer MCP Worker as designed).
2. If using INFRA OAuth connectors later, confirm `INFRA_CREDENTIAL_WRAPPING_KEY` is set before Save & Test.

**Verify:** onboarding checklist shows **Credential storage** complete when `authSecretRef` is set.

## 4. Team & administrator

1. Primary admin receives password-setup link from create flow (one-time token).
2. Portal → **Team** → invite additional users with role presets (Owner/Director, Manager, etc.).

**Verify:** at least one `company_admin`; onboarding **Administrator configured** complete.

## 5. Business systems (optional)

1. Portal → **Connections** → enable connectors from catalogue (Xero, Commusoft, etc.).
2. Complete OAuth or API-key setup per connector. Never paste secrets into chat or audit-visible fields.

**Verify:** auth status reflects real state (`connected`, `authentication_required`, etc.) — not fake "Connected".

## 6. Knowledge (optional)

1. Configure knowledge on the **company MCP** (Drive, SharePoint, etc.).
2. Control Plane → refresh MCP capabilities / knowledge counts.

**Verify:** document counts reported by MCP; INFRA does not store corpus in D1.

## 7. AI connection

1. Portal → **AI connections** → Connect ChatGPT or Claude.
2. Copy token **once**; configure AI client with INFRA gateway URL (`/api/gateway/v1/mcp`).
3. Run non-destructive test (health or knowledge search).

**Verify:** `lastUsedAt` updates; usage records appear; token not shown again after creation.

## 8. Billing

1. Confirm TEST credit on wallet (default for new companies).
2. Stripe TEST top-ups only when `STRIPE_SECRET_KEY` + webhook are configured (separate workstream).

**Verify:** ledger shows TEST credit; no fake £0.00 for unpriced operations in usage views.

## 9. Acceptance test

1. Via AI client: `system_health` or read-only knowledge query (non-destructive).
2. Confirm audit event, usage interaction, and wallet debit (TEST pricing) if billable.

**Verify:** onboarding **Acceptance test** complete when `usageCount > 0`.

## 10. Activate

1. When required onboarding items are complete, set company status to **active** (Control Plane → company → lifecycle).
2. Monitor **System health** and **Needs attention** on dashboard.

## Status reference

| Status | Meaning |
| --- | --- |
| `onboarding` | Default for new companies; AI may work if MCP registered but ops should finish checklist |
| `active` | Normal operation |
| `suspended` | Blocks chargeable AI and writes |
| `archived` | Retained record; access restricted (see ADR 008) |
| `closed` | Terminal; billing wind-down |

Readiness is **derived** from `GET /api/companies/:slug/onboarding` — never mark complete manually in UI without underlying config.

## Rollback

- Suspend company if misconfigured.
- Revoke AI tokens if compromised (see [AI token compromised](./runbooks/ai-token-compromised.md)).
- Do not delete D1 rows unless following a documented data-retention policy.
