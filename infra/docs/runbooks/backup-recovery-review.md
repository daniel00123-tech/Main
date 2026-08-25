# Backup and recovery review

**Review date:** 2026-08-25 (platform hardening). Documentation only — no new backup infrastructure added.

## Authoritative in INFRA D1

| Data | Authoritative? | Notes |
| --- | --- | --- |
| Companies, memberships, roles | Yes | Tenant identity |
| Wallets / ledger entries | Yes | Billing truth; cache healable from ledger |
| Usage records / interactions | Yes | Metering and support trace |
| MCP environment registry | Yes | Endpoints and capability metadata — not knowledge corpus |
| Connector instances | Yes | Status and credential **references** only |
| Service identities | Yes | Token hashes — not recoverable plaintext |
| Audit events | Yes | Compliance and support |
| Encrypted credentials (D1) | Yes | Requires `INFRA_CREDENTIAL_WRAPPING_KEY` to decrypt |
| Pricing rules / commercial config | Yes | |

## Not in INFRA D1 (remains elsewhere)

| Data | Location |
| --- | --- |
| Knowledge documents / chunks | Company MCP (+ Drive/SharePoint/etc.) |
| Xero / business-system payloads | Provider APIs + company MCP |
| MCP auth tokens | Cloudflare Worker secrets |
| Session cookies | Client; server validates via `SESSION_SECRET` |
| Stripe payment objects | Stripe (webhook → ledger) |

## If INFRA D1 were lost

- **Irrecoverable without backup:** all control-plane state above; AI tokens must be re-issued; OAuth connectors re-authenticated; MCP registry rebuilt from ops records
- **Reconstructable partially:** wallet from Stripe + usage exports if they exist; company list from ops docs
- **Unaffected:** company MCP Workers and their D1/R2; provider systems; Google Drive files

## Current backup posture

- Cloudflare D1: rely on CF account backup/export practices (not automated in this repo)
- **Recommendation:** scheduled D1 export to R2 or off-account storage before 10+ production tenants
- Worker secrets: document secret **names** in runbooks; values in CF dashboard only

## Recovery priority order

1. Restore D1 snapshot
2. Confirm Worker secrets (`SESSION_SECRET`, MCP auth refs, wrapping key)
3. Re-run health checks on all MCP environments
4. Validate gateway auth for one AI identity per tenant
5. Open reconciliation for ledger/usage integrity

## Test billing

TEST ledger credits are data — treat like production for recovery drills.
