# Microsoft 365 Future Company Onboarding (HT Readiness Audit)

Audit date: 2026-08-28. **No HT/Elvex connection performed.** Caddington Microsoft configuration unchanged.

## OneDrive / SharePoint — Future HT Administrator Journey

### Ideal target UX

1. Log into INFRA company portal (`/portal/ht-business`)
2. Open **Systems** → **Connectors**
3. Click **Connect** on Microsoft 365 → `/portal/ht-business/microsoft-365`
4. Click **Discover sources**
5. **Include** chosen OneDrive drives and SharePoint libraries
6. *(Optional)* Set **Folders** scope per source
7. **Sync now** on each included source
8. Verify indexed counts and run Company Knowledge search

### What works today (portal)

The portal dashboard supports discover → include/exclude → folder scope → sync for OneDrive/SharePoint **once platform credentials and knowledge bridge are configured**.

### What still requires operator/developer steps

| Step | Owner | Type |
|------|-------|------|
| Entra app registration (or multitenant app) | Operator | Azure Portal |
| Grant `Files.Read.All` + `Sites.Read.All` admin consent | HT M365 admin | Azure Portal |
| Set `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` on `infra-api` | Operator | Wrangler secrets |
| Register HT Business MCP + knowledge storage (R2/Vectorize) | Operator | Platform provisioning |
| Company-scoped knowledge bridge auth (today: `CADDINGTON_ADMIN_TOKEN` only) | Developer | Code gap |
| Per-company tenant token in discover/sync (today: global tenant secret) | Developer | Code gap |

### Human step counts

| Category | Count |
|----------|-------|
| **Portal human steps** (happy path, per admin) | **8–10** (+ repeat include/sync per source) |
| **Manual technical steps** (operator, before portal works) | **7** minimum for HT |

### Estimated onboarding time

- **Caddington (reference, secrets already set):** ~30–60 minutes for first full discover/sync cycle
- **HT (greenfield today):** ~4–8 hours including Entra setup, MCP knowledge provisioning, and developer wiring

### Classification: OneDrive / SharePoint

**PARTIAL** (portal UX ready) → **DEVELOPER_ASSISTED** end-to-end for a second tenant until multitenant secrets + company-scoped knowledge bridge land.

---

## Outlook Shared Mailbox — Separate Journey

Outlook is **not** self-service in the portal (informational notice only).

### Additional requirements

1. Entra: add `Mail.Read` (Application) — **not** broad delegated Mail.Read for all users
2. Entra: `User.Read.All` for mailbox discovery
3. Exchange Online PowerShell: Application Access Policy or RBAC for Applications scoped to approved shared mailboxes
4. API: `POST /api/companies/:slug/microsoft/outlook/discover`
5. API: `PATCH .../sources/:id/inclusion` per mailbox
6. API: `POST .../sources/:id/sync`
7. Acceptance: `run-cmd16b-outlook-rbac.mjs` (admin 200 / Daniel personal 403)

### Human step counts

| Category | Count |
|----------|-------|
| Portal human steps | **0** (no UI) |
| Entra + Exchange operator steps | **10** |
| API/script steps | **4** |

### Classification: Outlook shared mailbox

**DEVELOPER_ASSISTED** — requires Exchange RBAC bootstrap; cannot be completed through portal admin consent alone.

---

## Blockers before genuine second-tenant test

1. Single global `MICROSOFT_TENANT_ID` (Caddington) in Worker secrets
2. Discover/sync do not pass company context for token acquisition
3. Knowledge bridge hardcoded to Caddington admin token
4. HT MCP knowledge layer not configured (per seed notes)
5. No HT-specific acceptance tooling
6. Publisher Verification deliberately deferred (not a blocker for this sprint)

## Safety rules observed

- No HT/Elvex connection
- No Caddington disconnect/reconnect
- No Mail.Read re-add
- No Caddington Exchange RBAC changes
- CMD16C security boundary preserved
