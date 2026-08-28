# Caddington Pre-Phase-1 Hardening

Sprint scope: Google Drive whole-drive sync, Microsoft onboarding audit, Stripe live billing readiness.

## A. Google Drive Scope Modes

Per-company configuration lives in Caddington MCP D1 `connector_config` where `connector_code = 'google_drive'`.

| Field | Values | Default |
|-------|--------|---------|
| `scopeMode` | `ENTIRE_DRIVE` \| `SELECTED_FOLDERS` | `SELECTED_FOLDERS` |
| `imageIngestionPolicy` | `EXCLUDED` \| `ALLOWED` | `EXCLUDED` |
| `knowledgeFolderId` | Google folder ID | env `GOOGLE_DRIVE_KNOWLEDGE_FOLDER_ID` |

### Caddington configuration

```json
{
  "scopeMode": "ENTIRE_DRIVE",
  "imageIngestionPolicy": "EXCLUDED",
  "knowledgeFolderName": "Caddington Knowledge"
}
```

Apply remotely:

```bash
node infra/packages/caddington-mcp/scripts/configure-caddington-google-drive-scope.mjs
```

### Behaviour

- **ENTIRE_DRIVE:** scans My Drive from `root`; does not traverse shared drives (`includeItemsFromAllDrives=false`)
- **SELECTED_FOLDERS:** BFS from `knowledgeFolderId` (previous behaviour)
- Trash excluded via `trashed = false` query
- Google Photos excluded via MIME blocklist
- Shortcuts skipped (not traversed)
- Images excluded for Caddington via MIME prefix + extension blocklist

Shared types: `@infra/shared` → `google-drive-scope.ts`

### Acceptance

```bash
CADDINGTON_ADMIN_TOKEN=... node infra/packages/api/scripts/run-google-drive-whole-drive-acceptance.mjs
```

Admin routes on `caddington-mcp`:

- `GET /admin/connectors/google_drive` — status
- `GET /admin/connectors/google_drive/preview` — dry inventory
- `POST /admin/connectors/google_drive/sync` — `{ "dryRun": true }` or live sync

---

## B. Microsoft Future Onboarding

See [MICROSOFT-FUTURE-ONBOARDING.md](./MICROSOFT-FUTURE-ONBOARDING.md).

---

## C. Stripe Platform vs Company Billing

### Platform Stripe environment

Determined by `STRIPE_SECRET_KEY` prefix (`sk_test_` vs `sk_live_`).

`STRIPE_LIVE_MODE_ALLOWED = false` until explicit operator approval.

### Company billing mode

`companies.billing_mode`: `test` | `live`

| Platform | Company mode | Checkout |
|----------|--------------|----------|
| test | test | Allowed |
| test | live | Allowed (test keys) |
| live | test | **Blocked** |
| live | live | Allowed only if `STRIPE_LIVE_MODE_ALLOWED=true` |

Implementation: `company-billing-mode.ts` gates `createTopUpCheckoutIntent` and `ensureStripeCustomer`.

### Promotional / admin credits

Existing capability via `promotional-grants.ts` and `POST /api/companies/:slug/wallet/promotional-grants`.

- Ledger entry type: `promotional_credit`
- Tracked in `promotional_credit_grants`
- Consumed before paid wallet funds
- Does not create Stripe payments

### Caddington live £5 acceptance (human steps)

**No real payment is performed by automation.**

1. Operator sets `STRIPE_LIVE_MODE_ALLOWED = true` in code and deploys (explicit approval)
2. Set Caddington `billing_mode = 'live'` in D1
3. Confirm platform uses `sk_live_` keys
4. Daniel logs into portal → Billing → Top up **£5** (500 cents preset)
5. Complete Stripe Checkout with real card
6. Verify webhook credits wallet + ledger + portal balance
7. Optionally grant promotional credits via admin API for ongoing internal use

HT/Elvex billing modes remain unchanged unless explicitly updated.

### Top-up presets

`DEFAULT_TOP_UP_OPTIONS_CENTS`: `[500, 1000, 2500, 5000, 10000]` (£5 minimum for live acceptance).

---

## Regression

Run from `infra/packages/api`:

```bash
npm test
```

Key suites: Google scope, company billing mode, Stripe, Xero governance, Microsoft, automation.

---

## Future Google company onboarding

New operational companies should use their own Google Workspace account with `SELECTED_FOLDERS` or `ENTIRE_DRIVE` as appropriate. Caddington's personal-account Drive is **reference-only** and must not become platform default.
