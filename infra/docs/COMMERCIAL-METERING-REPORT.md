# INFRA Commercial Metering — Completion Report

Date: 24 August 2026  
Branch: `cursor/infra-commercial-metering-d3d8`  
PR: https://github.com/daniel00123-tech/Main/pull/290

## 1. Root cause of tonight’s missing debit

Live D1 showed:

| Fact | Value |
|------|--------|
| Opening credit | £10.00 |
| Wallet before this phase | £9.99 |
| Ledger usage debits before repair | **Exactly one** (−1p at 18:00:06Z) |
| Billable ChatGPT usage before repair | **One** `search_company_knowledge` / `knowledge.search` |

The request that reached INFRA **was billed correctly** (£10.00 → £9.99).

Later ChatGPT turns (~19:30) that returned Caddington content **never created gateway_requests / usage / ledger rows**. They did not enter the INFRA gateway — most likely because ChatGPT was still pointed at the **direct Caddington MCP URL**, and/or answers came from conversation context without new tool calls.

**Conclusion:** Metering was not “broken” for traffic that hit INFRA. The product gap was that ChatGPT could bypass INFRA by calling the company MCP directly.

Historic unpaid auto-debit was **not** performed. One settlement **pointer** gap (ledger existed, usage `settlement_status=unsettled`) was healed by linking only.

## 2. Code / database changes

- Migration `0007_commercial_pricing_metering.sql` — request IDs, settlement fields, pricing policies, provider rate cards/items/reviews, financial integrity exceptions
- Gateway: idempotent `client_request_id` / `request_id`, credit preflight (402), usage→ledger→settle, audit stages
- MCP facade: `ALL /api/gateway/v1/mcp`
- Pricing engine: 60% GM (`cost / (1 − margin)`), min £0.01, micros precision, TEST 1p fixed rules retained
- Provider cost registry + monthly review proposals (admin approval required)
- Reconciliation: heal link-only; flag unpaid usage / orphans / mismatches / duplicates / wallet drift — **never silent auto-debit**
- Admin UX: Usage KPIs + expandable commercial/audit; Billing test wallet; Commercial → Provider Costs / Pricing Rules
- Portal: MCP endpoint + “do not use company MCP directly”

## 3. Migrations applied

`0007_commercial_pricing_metering.sql` applied to remote D1 `infra-control-plane` (already present; re-apply reported no pending migrations).

## 4. Pricing architecture

- **Policies:** platform (and optional company) `target_margin_bps` default **6000** (60%), `minimum_charge_cents` default **1**
- **Rules:** fixed / target_margin / cost_plus / percent_markup / free; version + effective dates
- **Rate cards:** versioned provider catalogues; historic transactions keep rule/rate references
- **Current TEST customer charge** for Knowledge Search remains **£0.01 fixed** until measurable provider costs are configured and approved

## 5. Current Caddington wallet (after live INFRA proof)

**£9.96** — derived from ledger sum (source of truth):

| Entry | Amount | Balance after |
|-------|--------|---------------|
| Test promotional credit | +£10.00 | £10.00 |
| Original ChatGPT Knowledge Search | −£0.01 | £9.99 |
| Live proof #1 (gateway execute) | −£0.01 | £9.98 |
| Live proof #2 (new request) | −£0.01 | £9.97 |
| Live proof #3 (MCP facade) | −£0.01 | £9.96 |

Idempotent retry of proof #1 returned `idempotentReplay: true` with **no second debit**.

## 6. Unreconciled historic usage

- Pre-pricing `infra-admin-test` rows with `customer_charge_cents = null` — operational only, **£0**, not billed
- Original ChatGPT usage settlement pointer **healed** (linked to existing ledger; no new charge)
- No successful billable usage without a ledger debit remaining after heal

## 7. Provider cost configuration

Draft catalogues for Cloudflare / OpenAI / Anthropic with billing-unit schema. Unit costs are **0 / not configured** until admin verification. UI shows **Underlying cost: unavailable / not configured** rather than inventing numbers. Cursor is excluded from transaction COS.

## 8. 60% target gross margin

`customer_charge = underlying_cost / (1 − 0.60) = cost / 0.40`  
Not `cost × 1.60`. Stores `target_margin_bps` and `actual_margin_bps`. Minimum charge can raise realised margin above target.

## 9. Monthly provider-rate reviews

Admin “Check for updates” → `provider_pricing_reviews` (pending) → Platform Admin approval required before a new rate-card version becomes active. Scrapes/HTML changes cannot silently alter customer pricing.

## 10. Test results

**50 / 50** API tests passed (security, MCP, pricing commercial, reconciliation, insufficient-credit fixtures, ledger idempotency). Existing tenant isolation / SSRF / auth tests unchanged in intent.

## 11. Deployment status

| Component | Status |
|-----------|--------|
| `infra-api` Worker | Deployed (`3a1d579b-1107-4065-b200-f6f4cabf3131`) |
| `infra-web` Pages | Deployed (production + preview aliases) |
| D1 migration 0007 | Applied |
| Temporary metering service identity | **Disabled** after proof |

Live URLs:

- API: https://infra-api.daniel-dwyer123.workers.dev  
- Web: https://infra-web.pages.dev  
- MCP facade: https://infra-api.daniel-dwyer123.workers.dev/api/gateway/v1/mcp  

## 12. Manual ChatGPT acceptance procedure

**Critical:** ChatGPT must use the **INFRA MCP facade**, not `caddington-mcp…/mcp`.

1. Open INFRA → Billing → record Caddington balance (currently **£9.96**).
2. In Company Portal → AI connections, confirm MCP URL is  
   `https://infra-api.daniel-dwyer123.workers.dev/api/gateway/v1/mcp`  
   with Bearer token. If ChatGPT still has the old company MCP URL, reconnect/update it.
3. In ChatGPT ask: “Using Caddington, find Project Falcon's approved budget.”
4. Confirm genuine answer (£317,450).
5. INFRA → Usage: new row Company=Caddington, Client=ChatGPT, Operation=Knowledge Search, Completed.
6. Open the row: pricing, underlying-cost state, £0.01 charge, request/correlation IDs, rate/rule, ledger id, audit stages.
7. Billing: balance **£9.96 → £9.95** (under current 1p TEST rule) with a new ledger debit.
8. Second ChatGPT search → **£9.95 → £9.94**, two distinct ledger entries, no duplicates on refresh/retry.

## 13. Still mocked / deferred

- Stripe top-ups (not configured)
- Precise Cloudflare/OpenAI/Anthropic unit costs (draft / not configured)
- Automated HTML pricing scrapers (proposal workflow only)
- Insufficient-credit **live** demo (fixtures only — wallet not zeroed)
- WhatsApp AI client

## 14. Security / financial-integrity notes

- Direct company MCP remains reachable outside INFRA if someone has the URL — product guidance + portal copy now require INFRA facade for metering
- Ledger is immutable source of truth; corrections = compensating entries
- Temporary acceptance identity disabled; do not reuse its token
- Secrets/tokens are not logged in audit detail
