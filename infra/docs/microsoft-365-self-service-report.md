# MICROSOFT 365 SELF-SERVICE ONBOARDING — SPRINT 2 REPORT

**Date:** 2026-08-28 (updated)  
**Classification:** **MICROSOFT 365 SELF-SERVICE: PARTIAL — READY FOR LIVE SECOND-TENANT ACCEPTANCE**

---

## 1. Executive summary

Backlog Sprint 2 productises Microsoft 365 onboarding for OneDrive and SharePoint (not Outlook/mail). INFRA now supports three auth modes with backwards-compatible Caddington preservation:

| Mode | Description | Status |
|------|-------------|--------|
| `platform_legacy` | Existing Worker secrets → Caddington tenant | **Preserved** |
| `company_app` | BYO Entra app credentials + admin consent | **Implemented** |
| `platform_multitenant` | INFRA Business Connector SaaS app + per-company admin consent | **Enabled — awaiting live second-tenant demo** |

Portal onboarding wizard, admin consent callback, tenant binding, discovery, health test, disconnect/reconnect, audit events, and security tests are in place.

**28 August 2026:** Daniel completed manual Entra configuration. Production `MICROSOFT_MULTITENANT_APP=true` enabled. Structural acceptance and Caddington regression pass. A genuine second-company / second-Entra-tenant live onboarding remains outstanding (human admin consent required).

**CMD16C / Outlook RBAC:** Not modified. Exchange Application RBAC and Mail.Read exclusion unchanged. Security probes (admin 200 / Daniel 403) pass on production after Sprint 2 deploy.

**Publisher verification:** Deferred by product owner — future commercial hardening, not a Sprint 2 blocker.

---

## 1a. Entra configuration completed (28 August 2026)

| Item | Value |
| --- | --- |
| App display name | **INFRA Business Connector** (rename only) |
| Application (client) ID | `e5fd0533-ce51-43b8-999c-152f1e268246` (unchanged) |
| Supported account types | Multiple Entra ID tenants |
| Tenant policy | Allow all tenants |
| Redirect URI (Web) | `https://infra-api.daniel-dwyer123.workers.dev/api/connectors/microsoft/oauth/callback` |
| Implicit grant (access/ID tokens) | Disabled |
| `Files.Read.All` (Application) | Granted |
| `Sites.Read.All` (Application) | Granted |
| `User.Read.All` (Application) | Granted |
| `User.Read` (Delegated) | Granted |
| `Mail.Read` | **Not configured** (removed from app registration) |
| Publisher domain | `CaddingtonHoldings.co.uk` |
| Publisher verification | **Deferred** — Microsoft Partner Program out of scope for Stage 1 |

No replacement Entra app. No credential rotation. No Exchange service-principal relationship change.

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
| Portal (Pages) | Deployed (`37873fe6`) |
| D1 migration 0032 | Applied |
| `MICROSOFT_MULTITENANT_APP` | **Enabled** (`true`, 2026-08-28) |
| API deployment (multitenant enablement) | `01b949e9-af38-4757-8db9-907453253442` |
| Platform credentials | **PRESENT** (`MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`) |

---

## 15. Caddington regression results (28 August 2026)

| Check | Result |
| --- | --- |
| CMD13d discovery (`co_caddington`) | **PASS** — Graph auth OK, discovery complete |
| Admin MCP bridge | **PASS** |
| Google Drive knowledge regression | **PASS** |
| CMD16B security (admin 200 / Daniel 403) | **PASS** — Exchange RBAC unchanged |
| CMD16B idempotency / ingestion | **PASS** |
| `platform_legacy` binding | Preserved — no disconnect/reconnect |
| Outlook / Mail.Read / Exchange RBAC | **Untouched** |

Note: CMD16C search acceptance improvements (PR #331) are not on this Sprint 2 branch; production Outlook **security and ingestion** remain healthy.

---

## 16. Structural acceptance (28 August 2026)

| Check | Result |
| --- | --- |
| OAuth callback route | **PASS** (HTTP 302) |
| Microsoft status route | **PASS** (HTTP 401 unauthenticated) |
| CMD16B endpoint present | **PASS** |
| Unit tests (OAuth + productisation) | **18/18 PASS** |
| Full API suite | **410 passed**, 2 skipped |

---

## 17. External/manual configuration — remaining human action

### Live second-tenant acceptance (single remaining gate for PASS)

A **genuinely separate** Microsoft Entra tenant (not Caddington) is required. INFRA companies HT/EL exist but do not provide a second Entra tenant by themselves.

**Daniel's next step:**

1. Open INFRA portal for the target company (e.g. HT Business):  
   `https://infra-web.pages.dev/portal/ht-business/microsoft-365`
2. Sign in as INFRA company administrator.
3. Click **Connect using INFRA / SaaS** (`platform_multitenant`).
4. Complete Microsoft administrator login and **admin consent** in the customer's Entra tenant.
5. Return via callback → verify tenant binding → discover OneDrive/SharePoint → health test → sync/search.

Do **not** use Caddington as both sides of a second-tenant test.

### Deferred (not blockers)

- **Publisher verification** — future commercial hardening; Microsoft Partner Program out of scope for Stage 1
- **Sprint 3** — not started

### Completed (Daniel, 28 August 2026)

~~Entra multi-tenant app configuration~~  
~~`MICROSOFT_MULTITENANT_APP=true`~~  
~~Web redirect URI~~  
~~Application permissions (no Mail.Read)~~

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

- Live second-company / second-Entra-tenant onboarding **not yet demonstrated** (human admin consent required)
- Outlook/mail self-service explicitly deferred (CMD16C frozen baseline)
- Publisher verification deferred — not a current blocker
- `platform_legacy` disconnect disabled to protect Caddington production
- CMD16C search acceptance script improvements require PR #331 merge for ALPHA PASS classification on acceptance runner

---

## 22. Recommended next steps

1. **Daniel:** Complete live second-tenant onboarding via portal (see §17)
2. Re-classify Sprint 2 to **PASS** after successful end-to-end demo
3. Sprint 3 — not started until explicitly directed
4. Outlook remains separate track (CMD16C / Exchange RBAC), not Sprint 3 default

---

**Classification: MICROSOFT 365 SELF-SERVICE: PARTIAL — READY FOR LIVE SECOND-TENANT ACCEPTANCE**

**STOP — Sprint 3 not started.**
