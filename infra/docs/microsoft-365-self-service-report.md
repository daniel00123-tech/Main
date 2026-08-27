# MICROSOFT 365 SELF-SERVICE ONBOARDING — SPRINT 2 REPORT

**Date:** 2026-08-27  
**Classification:** **MICROSOFT 365 SELF-SERVICE: PARTIAL**

---

## 1. Executive summary

Backlog Sprint 2 productises Microsoft 365 onboarding for OneDrive and SharePoint (not Outlook/mail). INFRA now supports three auth modes with backwards-compatible Caddington preservation:

| Mode | Description | Status |
|------|-------------|--------|
| `platform_legacy` | Existing Worker secrets → Caddington tenant | **Preserved** |
| `company_app` | BYO Entra app credentials + admin consent | **Implemented** |
| `platform_multitenant` | INFRA SaaS app + per-company admin consent | **Implemented (awaiting Entra config)** |

Portal onboarding wizard, admin consent callback, tenant binding, discovery, health test, disconnect/reconnect, audit events, and security tests are in place. A genuine second-company live tenant onboarding was **not** demonstrated end-to-end (no second Entra tenant available in this run).

**CMD16B / Outlook RBAC:** Not modified. Existing Caddington Outlook configuration unchanged.

---

## 2. Architecture before

| Layer | State |
|-------|-------|
| Auth | Platform-global `MICROSOFT_*` Worker secrets only |
| Token | Client credentials → always platform tenant |
| OAuth | Stub delegated flow; no callback route |
| Per-company | `microsoft_tenant_id` column existed but unused for auth |
| Portal | Link to dashboard; no Connect flow |
| Blockers | Blanket `MICROSOFT_SINGLE_TENANT_PLATFORM` |

---

## 3. Architecture after

```
Company Portal → Microsoft 365 → Connect
    ├─ company_app: store encrypted {tenantId, clientId, clientSecret}
    │       → admin consent URL (tenant-specific)
    │       → callback binds microsoft_tenant_id
    │       → client credentials per company
    └─ platform_multitenant: platform app + organizations admin consent
            → requires MICROSOFT_MULTITENANT_APP=true + Daniel Entra work

Discovery/Sync → acquireMicrosoftAppToken(companyId, instanceId)
    → resolveMicrosoftAppCredentials → tenant-aware Graph token

Caddington (unchanged path) → platform_legacy auto-bind on discover
    → uses existing MICROSOFT_* secrets
```

---

## 4. Multi-tenant OAuth design

- **Admin consent** (not delegated OAuth) for application permissions: `Files.Read.All`, `Sites.Read.All`, `User.Read.All`
- **No Mail.Read** — Outlook explicitly excluded
- URL: `https://login.microsoftonline.com/{tenant}/v2.0/adminconsent?client_id=...&redirect_uri=...&state=...`
- Callback: `GET /api/connectors/microsoft/oauth/callback`
- PKCE state stored encrypted in `oauth_authorization_states` (one-time consume, 10-minute TTL)
- Platform multi-tenant uses `organizations` tenant segment; BYO uses customer's tenant ID

---

## 5. Token/security model

- **App-only client credentials** after admin consent (no refresh tokens stored)
- BYO secrets encrypted via `INFRA_CREDENTIAL_WRAPPING_KEY` → `credential_refs` + `secret_ciphertexts`
- In-memory token cache keyed by `{authMode}:{tenantId}:{clientId}`
- Tokens never returned to portal clients
- Disconnect revokes encrypted credentials (except `platform_legacy`)

---

## 6. Tenant binding

On successful admin consent callback:

- `connector_instances.microsoft_tenant_id` = Entra tenant from callback
- `external_account_id` mirrored for compatibility
- **BYO mode:** callback tenant must match stored `tenantId` (blocks tenant substitution)
- Audit: `connector.connected` with masked tenant ID

---

## 7. SharePoint onboarding

- Unchanged discovery/sync pipeline; now **company-scoped** token acquisition
- Portal: discover → include/exclude → folder scope → sync
- Sources stored in `microsoft_connector_sources`

---

## 8. OneDrive onboarding

- Same as SharePoint — discovery via Graph `/drives` + user OneDrives
- Inclusion/exclusion and folder scope unchanged
- Bulk "include all OneDrives" warning retained

---

## 9. Portal UX

**`/portal/{slug}/microsoft-365`:**

- Connect (BYO Entra app) / Connect (INFRA SaaS app)
- Save Entra app credentials form
- Test connection / Disconnect
- Connection status (auth mode, masked tenant)
- OAuth return handling (`?microsoft=connected|error`)
- Discovery and source management (existing)

**Connectors wizard:** Microsoft steps now use OAuth action kind (not navigate-only).

---

## 10. API changes

| Endpoint | Change |
|----------|--------|
| `GET /api/connectors/microsoft/oauth/callback` | **New** — admin consent callback |
| `POST .../connectors/microsoft/oauth/start` | Admin consent + authMode param |
| `POST .../connectors/:id/test` | Microsoft Graph health test |
| `POST .../connectors/:id/disconnect` | Microsoft disconnect |
| `GET .../microsoft/dashboard` | Company-scoped health + instanceId |
| `POST .../microsoft/discover` | Auto `platform_legacy` bind for Caddington |

---

## 11. D1 migrations

**0032_microsoft_self_service.sql** (applied to production):

```sql
ALTER TABLE connector_instances ADD COLUMN microsoft_auth_mode TEXT;
ALTER TABLE connector_instances ADD COLUMN microsoft_consented_at TEXT;
ALTER TABLE connector_instances ADD COLUMN microsoft_consented_by TEXT;
CREATE INDEX idx_connector_instances_microsoft_auth ...;
```

---

## 12. Tests

- **410 API tests passing** (9 new Microsoft OAuth/security tests)
- `microsoft-oauth.test.ts`: admin consent, tenant substitution block, state replay, cross-company state, disconnect guards

---

## 13. Security tests

| Test | Result |
|------|--------|
| OAuth state tampering | PASS |
| Callback replay | PASS |
| Tenant substitution (BYO) | PASS |
| Cross-company state binding | PASS |
| Token exposure in API responses | PASS (masked tenant only) |
| Platform legacy disconnect guard | PASS |
| Unauthenticated callback | Redirect with error (no token leak) |

---

## 14. Production deployment status

| Component | Status |
|-----------|--------|
| API Worker | Deployed |
| Portal (Pages) | Deployed |
| D1 migration 0032 | Applied |
| `MICROSOFT_MULTITENANT_APP` | **Not set** (awaiting Daniel) |

---

## 15. Caddington regression results

- **CMD16B endpoint:** Present (HTTP 403 without token — unchanged)
- **No modifications** to Outlook ingestion, Exchange RBAC, Mail.Read, graph subscriptions
- **Discover path:** `ensureMicrosoftLegacyBinding` preserves platform secrets path
- **Existing sync:** Uses `companyId`-scoped token resolution; falls back to platform credentials for legacy

---

## 16. External/manual Microsoft configuration still required (Daniel)

### For platform multi-tenant SaaS (`platform_multitenant`)

1. **Entra app registration** (existing INFRA app OR new multi-tenant app):
   - Supported account types: **Accounts in any organizational directory**
   - Redirect URI: `https://infra-api.daniel-dwyer123.workers.dev/api/connectors/microsoft/oauth/callback`
2. **Application permissions** (admin consent): `Files.Read.All`, `Sites.Read.All`, `User.Read.All` — **not Mail.Read**
3. **Publisher verification** (recommended for customer admin consent)
4. **Worker secret:** `MICROSOFT_MULTITENANT_APP=true`
5. Optionally update `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` if using a new app registration

### For BYO path (`company_app`)

Customer admin creates their own Entra app — no platform Entra changes required.

---

## 17. Branch

`cursor/infra-m365-self-service-d3d8`

---

## 18. Commit SHA

`d29ef55` (latest)

---

## 19. PR

https://github.com/daniel00123-tech/Main/pull/new/cursor/infra-m365-self-service-d3d8

---

## 20. Deploy/version ID

- **API Worker:** `4692396e-a007-4302-b633-a7445925cf18`
- **Portal Pages:** `37873fe6` (https://37873fe6.infra-web.pages.dev)

---

## 21. Known limitations

- Platform multi-tenant onboarding blocked until `MICROSOFT_MULTITENANT_APP=true` + Entra multi-tenant config
- No live second-company tenant demonstration in this sprint
- Outlook/mail self-service explicitly deferred (CMD16B untouched)
- Publisher-verified admin consent may still require manual customer IT step
- `platform_legacy` disconnect disabled to protect Caddington production

---

## 22. Recommended next steps (Sprint 3+)

1. Daniel completes Entra multi-tenant configuration; set `MICROSOFT_MULTITENANT_APP=true`
2. Demonstrate HeatTech/Elvex onboarding via BYO or platform path
3. MCP admin bridge generalisation per company (beyond Caddington token)
4. Scheduled sync activation post-onboarding
5. Outlook remains separate backlog (CMD16B+), not Sprint 3 default

---

**STOP — Sprint 2 complete. Sprint 3 not started.**
