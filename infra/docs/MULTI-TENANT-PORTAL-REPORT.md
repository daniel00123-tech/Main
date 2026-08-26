# INFRA Multi-Tenant Company Portal — Delivery Report

## 1. Architecture implemented
- Two layers: **Platform Admin** (control plane) and reusable **Company Portal** (`/portal/:companySlug/...`)
- Logical multi-tenancy in shared D1 + Workers (no per-tenant Cloudflare sprawl)
- Tenant identity: `company_id`, `slug`, `portal_subdomain`, `portal_hostname`
- Path-based portal routing now; hostname/subdomain resolution ready for custom domain wildcards

## 2. Existing components reused
- `companies`, memberships, service identities, wallet/ledger, gateway, pricing, usage, audit, AI connections, connector catalogue
- MCP facade + Caddington service binding preserved
- Commercial metering / 60% GM pricing retained

## 3. Database / schema changes
- Migration `0008_tenant_provisioning.sql` (applied remote)
- Extended `companies` profile + portal fields
- `company_modules`, `company_commercial_settings`
- Caddington attached (not duplicated): subdomain `caddington`, hostname `caddington.infra-web.pages.dev`

## 4. Company creation workflow
- Platform Admin → Companies → **New Company** (5-step wizard)
- API: `POST /api/companies` (platform admin)
- Auto-provisions wallet, commercial settings, AI shells, modules, optional admin invite

## 5. Tenant / subdomain routing
- Primary: `/portal/{slug}/...` with company switcher
- Resolve helpers: `GET /api/portal/resolve?slug|host|subdomain`
- Hostname field stored for future `*.infra` wildcard DNS
- Never trust frontend-only tenant IDs: membership + auth + company status enforced server-side

## 6. Tenant isolation controls
- Gateway rejects cross-company service identities
- Suspended/closed companies blocked from gateway
- Portal loads overview only for accessible company slug
- Separate wallets / ledgers / AI connections / audit per company_id

## 7. Company Portal screens
- Overview, Connections, AI Connections, Team, Usage, Billing, Activity, Settings
- Features gated by role; modules catalogue-driven (not hard-coded per brand)

## 8. AI Connection workflow
- Connect / Generate·Reconnect token (plaintext once)
- Revoke, Test connection (gateway health + knowledge search path)
- Copy INFRA MCP URL + Bearer token

## 9. Caddington migration / result
- Existing `co_caddington` retained
- Wallet **£9.94** intact
- Portal: `/portal/caddington-holdings/...`
- ChatGPT AI connection preserved

## 10. ChatGPT connection procedure
1. https://infra-web.pages.dev → sign in
2. Companies → Caddington Holdings → Open portal **or** `/portal/caddington-holdings/ai-connections`
3. ChatGPT → Generate / Reconnect token → copy token + INFRA MCP URL
4. ChatGPT MCP = `https://infra-api.daniel-dwyer123.workers.dev/api/gateway/v1/mcp` + Bearer only

## 11. Billing / metering behaviour
- Per-tenant wallet/ledger (source of truth)
- TEST knowledge search still £0.01
- Target GM 60% model retained (`charge = cost / 0.40`)
- Idempotent / atomic debit path unchanged

## 12. Security controls
- Token hashed at rest; plaintext shown once
- Direct Caddington MCP remains locked (401 without INFRA secret)
- Suspend disables service identities
- Audit events without secrets

## 13. Second test tenant result
- Created **INFRA Test Company** (`co_infra_test`, slug `infra-test-company`, subdomain `infra-test`)
- Separate wallet (£1.00 opening), AI shells, modules, audit
- Caddington balance unchanged at £9.94
- Visible in Companies list / portal switcher for isolation proof; suspend/close from UI when done

## 14. Tests passed
- API: **55** tests including tenant provisioning isolation + suspend gate

## 15. Production deployment status
- D1 migration 0008 applied
- `infra-api` Worker deployed
- `infra-web` Pages deployed (production)

## 16. Still mocked / deferred
- Full custom-domain wildcard DNS (hostname fields ready; Pages path routing works today)
- Commusoft / BigChange / WhatsApp / Claude live integrations
- Live Stripe top-ups (foundation only)
- Per-tenant MCP Worker bindings beyond Caddington (catalogue + connect flow ready)
- Logo upload storage
- Knowledge module deep UI beyond MCP-backed counts

## 17. Exact next steps for you
1. Open https://infra-web.pages.dev and sign in
2. Confirm Companies shows **Caddington Holdings** and **INFRA Test Company**
3. Open Caddington portal → AI Connections → ChatGPT → Generate/Reconnect token
4. Point ChatGPT at INFRA MCP URL only; new chat; knowledge search
5. Expect Usage row + Billing **£9.94 → £9.93** once
6. Optionally open INFRA Test portal and confirm empty/isolated data
7. Suspend or close INFRA Test Company when finished
8. Future HT/EL: Companies → New Company (no Cursor/code required for logical tenant)
