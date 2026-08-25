# INFRA Phase 1 — Live Production Foundation Readiness Report

**Date:** 2026-08-24  
**Branch:** `cursor/infra-platform-v0-1-d3d8`  
**Deployment status:** Code prepared. **Cloudflare deployment not executed** (awaiting approval).

---

## 1. READY TO DEPLOY or NOT READY

**READY TO DEPLOY** — with the pre-deployment checklist in sections 25–27 completed at deploy time.

Code, migrations, auth, tenant isolation, permissions, secured API, and tests are in place. Permanent Cloudflare resources have **not** been created yet per instruction.

---

## 2. Files changed

### New files
- `infra/migrations/0002_identity_and_auth.sql`
- `infra/packages/api/src/auth/*` (password, session, middleware, users, tests)
- `infra/packages/api/src/permissions/service.ts` (+ tests)
- `infra/packages/api/src/cors.ts`
- `infra/packages/api/.dev.vars.example`
- `infra/packages/web/src/context/AuthContext.tsx`
- `infra/packages/web/src/pages/LoginPage.tsx`
- `infra/packages/web/src/portal/usePortalCompany.ts`
- `infra/docs/PHASE-1-READINESS-REPORT.md`

### Modified files
- `infra/packages/api/src/index.ts` — auth, protected routes, audit, permissions API
- `infra/packages/api/src/env.ts`, `db/mappers.ts`, `services/control-plane.ts`, `seed.sql`, `wrangler.toml`, `package.json`
- `infra/packages/shared/src/types.ts`
- `infra/packages/web/src/api.ts`, `App.tsx`, `main.tsx`
- Admin + portal pages wired to live API (see section 11)

---

## 3. New migrations

**`0002_identity_and_auth.sql`**
- `users`, `company_memberships`, `role_action_grants`, `service_identities`
- Extended `mcp_environments`: `enabled`, `mcp_version`, `business_mcp_core_version`, `capabilities_json`, `auth_secret_ref`

---

## 4. Authentication architecture

Email + password with server-side verification. Passwords hashed with **PBKDF2-SHA256** (210,000 iterations) via Web Crypto. Bootstrap admin from env when no users exist.

---

## 5. Session architecture

Signed **JWT in HttpOnly cookie** (`infra_session`) using `jose` HS256. TTL 12 hours. Local dev uses Vite proxy (same-origin). Production cross-origin requires `COOKIE_CROSS_ORIGIN=true`.

---

## 6. User / company membership model

`users` ↔ `company_memberships` ↔ `companies` (many-to-many). Platform admin via `is_platform_admin`. Server-side membership validation on all company routes.

---

## 7. Role model

Platform Admin (platform level) + company presets: Engineer, Junior Office, Office Staff, Supervisor, Manager, Director, Company Admin.

---

## 8. Granular permission model

Role preset → optional `role_action_grants` override → `evaluateActionPermission()` → `ToolAction`. Reusable by future MCP gateway. `POST /api/permissions/check`.

---

## 9. Read / write risk model

Actions mapped to `low_risk`, `write`, `financial_action`, `external_send`, `delete`, `batch_write`, `high_risk`. No approval engine yet.

---

## 10. Tenant isolation implementation

`userHasCompanyAccess()` on all scoped routes. Platform admin explicit bypass. Automated tests for 401 unauthenticated and 403 cross-company.

---

## 11. Frontend pages now using live API

Admin: login, dashboard, companies, company detail, MCP environments, audit log, users/roles.  
Portal: login, dashboard, connectors, team.

---

## 12. Pages still using demo/mock data

Admin: usage, billing, AI clients, system health.  
Portal: usage, billing, AI connections, settings.  
Company detail advanced tabs not implemented.

---

## 13. MCP registry changes

Extended metadata fields; `auth_secret_ref` only (no plaintext tokens). Caddington MCP registered as external metadata.

---

## 14. Connector registry state

Registry-only seed entries. No live business system connections.

---

## 15. MCP health security changes

Auth required; company access required; registered URL only; SSRF validation; audited.

---

## 16. Audit implementation

Login, logout, login_failed, company.accessed, permission.denied, mcp.health_checked. No secrets in audit payloads.

---

## 17. Usage / metering state

Tables retained. No billing engine, no Stripe, no usage ingest in Phase 1.

---

## 18. Cursor Bridge state

Not implemented. Docs only (`infra/docs/CURSOR-BRIDGE.md`).

---

## 19. Test results

`npm test` — **PASS** (27 tests: api 19, shared 8)

---

## 20. Typecheck result

`npm run typecheck` — **PASS**

---

## 21. Build result

`npm run build` — **PASS** (@infra/web)

---

## 22. Security review

All checklist items pass (see full table in PR description). No secrets committed. No public admin APIs. Server-side authZ. Cross-company tests pass.

---

## 23. Required permanent Cloudflare resources

| Resource | Name |
|----------|------|
| Worker | `infra-api` |
| D1 | `infra-control-plane` |
| Pages | `infra-web` |

---

## 24. Required production secrets / environment variables

**REQUIRED NOW:** `SESSION_SECRET`, `ALLOWED_ORIGINS`, `COOKIE_CROSS_ORIGIN=true`, `ENVIRONMENT=production`, `VITE_API_BASE`, real D1 `database_id`  
**OPTIONAL:** `INITIAL_PLATFORM_ADMIN_EMAIL`, `INITIAL_PLATFORM_ADMIN_PASSWORD` (bootstrap only)  
**FUTURE:** Stripe, MCP secret bindings, metering

---

## 25. Estimated baseline monthly cost

~**$0–10/month** (Workers + D1 + Pages free/low tier at initial traffic)

---

## 26. Remaining deployment blockers

1. Your approval (no deploy yet)  
2. Create production D1 + update wrangler  
3. Set secrets/vars  
4. Run remote migrations  
5. Deploy Worker + Pages  
6. Bootstrap admin + Caddington tenant  
7. Verify cross-origin auth  
8. Remove bootstrap secrets

---

## 27. Exact permanent deployment sequence

```bash
wrangler d1 create infra-control-plane
# update database_id in wrangler.toml
wrangler secret put SESSION_SECRET
wrangler d1 migrations apply infra-control-plane --remote
npm run deploy --workspace=@infra/api
VITE_API_BASE=https://infra-api.<account>.workers.dev npm run build --workspace=@infra/web
wrangler pages deploy packages/web/dist --project-name=infra-web
```

---

## Recommendation

**READY FOR CLOUDFLARE DEPLOYMENT**

Proceed after you approve this report. No Cloudflare deployment has been performed.
