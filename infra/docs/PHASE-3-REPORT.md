# INFRA Phase 3 — Final Report

**Verdict: PARTIALLY READY → operational foundation live**

INFRA has progressed from an admin dashboard into a working multi-tenant control plane with gateway, wallet ledger, service identities, and company portal controls. Stripe live payments await credentials. External connector APIs (BigChange etc.) are framed but not integrated.

---

## 1. READY / PARTIALLY READY / NOT READY

**PARTIALLY READY (production-usable for Caddington gateway + portal ops)**

Ready now:
- Company portal with live wallet/usage/MCP/AI connection generation
- INFRA Gateway (service token + session)
- Permissions + allowlists enforced server-side
- Ledger-backed wallet + test pricing debit
- Service identities / AI client connection tokens
- Tenant isolation (including service spoof → 403)

Blocked / deferred:
- Live Stripe Checkout (needs `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`)
- ChatGPT/Claude vendor-side wiring (INFRA side ready; manual client config required)
- Real BigChange/Commusoft/Xero API connectors
- Approval workflows

## 2. Live URLs

| Surface | URL |
|---------|-----|
| Web | https://infra-web.pages.dev |
| API | https://infra-api.daniel-dwyer123.workers.dev |
| Gateway | https://infra-api.daniel-dwyer123.workers.dev/api/gateway/v1/execute |
| Gateway health | https://infra-api.daniel-dwyer123.workers.dev/api/gateway/v1/health |
| Caddington MCP (direct, unchanged) | https://caddington-mcp.daniel-dwyer123.workers.dev/mcp |

## 3. Git branch and PR

- Branch: `cursor/infra-platform-v0-1-d3d8`
- PR: https://github.com/daniel00123-tech/Main/pull/286

## 4. Migrations added/applied

| Migration | Status |
|-----------|--------|
| `0006_control_plane_gateway_wallet.sql` | Applied remote ✅ |

## 5. New database tables

- `ledger_entries` (append-only wallet history)
- `pricing_rules` (test pricing configuration)
- `stripe_checkout_sessions`
- `stripe_webhook_events`
- `gateway_requests`
- `mcp_tool_action_map`
- `ai_client_connections`
- `action_approval_policies` (schema only; workflow not built)

Also extended: `users.last_login_at`, `service_identities` (type/token_hash/scopes/counters), `credit_balances` (threshold/stripe customer id).

## 6. Company Portal status

Live sections:
- Dashboard (credit, usage, MCP health, activity)
- Connectors (instances + catalogue framework)
- AI Connections (generate INFRA token + endpoint)
- Team (invite, disable/reactivate, role change)
- Usage (live metering)
- Billing/wallet (ledger + top-up intents)
- Settings (company profile)

## 7. Platform Admin status

- Companies / company detail enriched with wallet + usage
- Billing page shows live platform balances
- MCP Environments + Test MCP retained
- Users & Permissions live list
- Audit live

## 8. User/role system status

- Invite → password setup token/link (share manually; no email provider yet)
- Disable / reactivate
- Role change (7 presets)
- Last login recorded
- Platform Admin remains separate from company roles

## 9. Permission architecture

- Central presets in `@infra/shared` (`COMPANY_ROLE_PRESETS` + `TOOL_ACTION_RISK`)
- Company overrides via `role_action_grants`
- Service scopes + optional `permission_grants`
- MCP tool allowlist + tool→action map
- Denials audited

## 10. Service identity architecture

- Company-scoped identities (ChatGPT/Claude/etc.)
- Token generated once; **SHA-256 hash only in D1**
- Rotate / disable
- Scopes default to knowledge read/search + system.health
- Last used + request count

## 11. INFRA Gateway architecture

```
AI Client / Admin
  → POST /api/gateway/v1/execute
  → authenticate (Bearer service token OR session)
  → identify company
  → permission check
  → credit preflight (if billable)
  → registered MCP only (no arbitrary URL)
  → execute allowlisted tool
  → usage + ledger debit (idempotent by usage id)
  → gateway_requests + audit
  → response + correlationId
```

Generic — Caddington is configuration, not hard-coded routing logic.

## 12. Read/write action architecture

- Risk classes retained: low_risk / write / financial_action / delete / batch_write / external_send / high_risk
- Gateway logs `action` + `riskClass`
- `action_approval_policies` table reserved (not enforced yet)
- Phase knowledge tests remain read-only

## 13. Caddington end-to-end gateway test

| Step | Result |
|------|--------|
| Create ChatGPT service identity | ✅ token issued once |
| Gateway `search_company_knowledge` (“annual leave policy”) | ✅ status 200, resultCount 3, ~1316 ms |
| Correlation | `corr_53d641d1-2b16-4eae-a3a2-a7b6f379a20e` |
| Wallet | 1000 → **999** (−1p TEST debit) |
| Ledger | `usage_debit` with pricing label marked test |
| Denied out-of-scope tool (`query_business_data`) | ✅ 403 scope denial |
| Cross-tenant spoof (`co_el`) | ✅ 403 |
| Unauthenticated | ✅ 401 |
| Direct Caddington MCP health | ✅ unchanged |

## 14. Usage metering status

- Gateway writes usage records with action, risk, latency, correlation, charge fields
- Failed requests not charged (default)
- Test pricing: `knowledge.search` = 1p success

## 15. Wallet/ledger status

- Append-only ledger; balance derived/reconciled from entries
- Opening promotional £10.00 test credit for Caddington
- Portal + platform admin balance views
- Low-balance threshold (£5 default)

## 16. Stripe status

**Application ready; credentials required from you:**

```bash
cd infra/packages/api
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

Webhook endpoint: `POST https://infra-api.daniel-dwyer123.workers.dev/api/stripe/webhook`

Until set: top-up records intent with `pending_credentials`; `stripeConfigured: false`.

## 17. Connector framework status

- Catalogue definitions remain platform-wide
- Instance create API stores config without plaintext secrets
- `credential_refs` stores **secret_ref name only**
- Credential list API omits secret values
- No BigChange/Xero live API yet

## 18. AI Connections status

- ChatGPT / Claude: “Generate INFRA connection” → service identity + token + gateway endpoint
- WhatsApp: coming soon
- Setup copy instructs routing **through INFRA**, not direct MCP

## 19. Credential/security architecture

- MCP auth: Worker secret ref + service binding
- Service tokens: hash-only in D1
- Connector secrets: ref-only pattern
- No secrets in frontend responses or audit payloads

## 20. Audit logging

Events include: auth, invites, role/status changes, gateway permission denials, MCP execution, billing adjustments, credential create/rotate. Correlation IDs on gateway path.

## 21. Security test results (live + automated)

| Test | Result |
|------|--------|
| Unauthenticated gateway | 401 |
| Service tenant spoof | 403 |
| Out-of-scope / non-allowlisted tool | 403 |
| Private MCP URL validation | unit tests pass |
| Duplicate usage ledger debit | idempotent (unit) |
| Failed request not charged | unit |
| Token hash ≠ plaintext | unit |

## 22. Automated test results

- API: **38** passed
- Shared: **12** passed

## 23. Typecheck / build

- `npm run typecheck` ✅
- `npm run build` ✅

## 24. Live deployment results

- `infra-api` deployed (service binding `CADDINGTON_MCP` retained)
- `infra-web` Pages deployed
- D1 `0006` applied; phase3 seed applied
- No new Workers/D1/Pages projects created

## 25. Mock / demo areas remaining

- Admin AI Clients / System Health / Settings still partly static
- Usage pricing is **test configuration** (labelled)
- Stripe Checkout inactive without secrets
- WhatsApp / external write connectors not live
- Email delivery for invites not implemented (link returned to admin)

## 26. Cloudflare resources created

**None new.** Extended existing `infra-api`, `infra-web`, `infra-control-plane` only.

## 27. Estimated ongoing baseline cost

Unchanged order of magnitude: Workers + Pages + D1 free/low tier for current traffic. No R2/Vectorize/Queues added. Stripe fees only if/when enabled.

## 28. Errors / problems encountered

1. Cross-tenant spoof initially 500’d due to FK when auditing non-existent company → fixed to audit against service’s real company and return 403.
2. Stripe cannot complete live Checkout without your API keys (by design).

## 29. Technical debt / deferred

- Email invite delivery
- Approval workflow engine (schema only)
- Admin pages polish (AI Clients / System Health)
- Cost+markup pricing modes unused until supplier costs known
- Gateway response may still include rich MCP result payloads (OK for admin/AI; consider size limits later)
- Race on concurrent wallet debit under extreme concurrency (D1 single-row updates; acceptable for v1)

## 30. Exact recommended NEXT PHASE

1. **You provide Stripe secrets** → enable live prepaid top-ups end-to-end.
2. **Wire one AI client (ChatGPT or Claude) for Caddington** using the generated INFRA gateway token (keep direct MCP as fallback until stable).
3. **First real business connector connect-flow** (credentials + Test Connection) — Google Drive metadata already present; or BigChange when credentials available.
4. Then commercial pricing review (replace test 1p rules).

---

**Operator note:** Sign out/in if needed. Open **Company Portal → Caddington Holdings** for wallet/AI Connections/Team. Platform Admin → Billing for balances. Gateway proof already run live against Caddington MCP without modifying that Worker.
