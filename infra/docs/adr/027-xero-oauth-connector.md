# ADR 027 — Reusable Xero OAuth connector

- **Status:** Accepted
- **Date:** 2026-08-25
- **Depends on:** ADR 001, ADR 006, ADR 007, ADR 012, ADR 015, ADR 018, ADR 019, ADR 020, ADR 021, ADR 026
- **Supersedes:** ADR 015 “architecture only / do not collect credentials”; ADR 021 “Xero is specified, not activated”

## Decision

Xero is a **reusable company connector**. Any INFRA company connects it from Company Portal → Connectors → Xero. Caddington is the first production tenant, not a special-case implementation.

```
Xero
  → Company Business MCP / company data layer
  → INFRA control plane (identity, OAuth, encrypted tokens, permission, meter, audit)
  → ChatGPT / Claude / other AI clients
```

INFRA stores connector configuration, encrypted tokens, permissions, usage, and audit. INFRA does **not** become a Xero accounting warehouse. Live accounting reads stay on Xero and the company Business MCP.

## OAuth flow

1. Authenticated company admin or director opens Connectors → Xero → Connect Xero.
2. `POST /api/companies/:slug/connectors/conn_xero/oauth/start` creates or reuses that company's `conn_xero` instance.
3. INFRA issues a random `state`, hashes it, and stores the row with `company_id`, `user_id`, instance id, scopes, redirect URI, and an encrypted PKCE verifier (AAD `oauth-pkce|{companyId}|{stateId}`).
4. Browser is sent to `login.xero.com` with `response_type=code`, PKCE S256, and the registered redirect URI.
5. Xero returns to `GET /api/connectors/xero/oauth/callback`.
6. INFRA consumes the hashed state (single use, expiry 10 minutes). Company/user come from the state row. A browser-supplied company id is never trusted.
7. INFRA exchanges the authorization code + PKCE verifier, lists Xero connections, and stores the token payload via `EncryptedD1SecretProvider`.
8. If exactly one organisation is connected, the instance becomes Connected. If several, the portal asks the user to confirm one organisation.
9. Portal return: `/portal/:slug/connectors?xero=connected|select_org|error`.

Reconnect repeats the same start URL. Disconnect deletes the Xero connection when possible, then revokes the local ciphertext.

## Scopes (phase one — read only)

| Scope | Why |
| --- | --- |
| `offline_access` | Refresh token so the company does not re-consent on every expiry. |
| `accounting.settings.read` | Organisation profile, accounting settings, chart of accounts. |
| `accounting.contacts.read` | Customers/suppliers for debtor and invoice counterparties. |
| `accounting.transactions.read` | Invoices, credit notes, payments, bank transactions (read). |
| `accounting.reports.read` | Bounded P&L and other reports Xero already computes. |

Write scopes (`accounting.transactions`, `accounting.contacts`, `accounting.settings`, payroll, attachments) are listed as `writeScopesNeverRequested` and must not be added without a new ADR. Tool contracts can gain write tools later without redesigning the connector.

## Secrets

Xero **application** credentials are Worker secrets on `infra-api` only:

- `XERO_CLIENT_ID`
- `XERO_CLIENT_SECRET`
- `XERO_OAUTH_REDIRECT_URI` (optional; default is the registered callback)

Per-company access/refresh tokens use ADR 026 (`INFRA_CREDENTIAL_WRAPPING_KEY` / `INFRA_CREDENTIAL_KEY_VERSION=v1`). Never store tokens in ordinary D1 columns, logs, audit events, frontend state, URLs, or Git.

## MCP boundary

Allowlisted read tools:

- `xero_organisation_read`
- `xero_contacts_search`
- `xero_invoices_search`
- `xero_invoices_get`
- `xero_payments_read`
- `xero_accounts_list`
- `xero_bank_transactions_read`
- `xero_profit_and_loss`

INFRA confirms the same-company Xero instance is connected and the tool is a read contract. It then forwards to the company Business MCP. If that MCP does not implement the tool, INFRA returns `XERO_MCP_UNAVAILABLE` and **does not invent figures**. Write tools return `FINANCIAL_WRITES_DISABLED`. INFRA does not advertise Xero tools until the company MCP lists them.

## Metering

`xero.health`, `xero.token_refresh`, and `xero_connection_test` are not customer-billable. TEST knowledge prices stay 1p. Future Xero reads through the company MCP use the Interaction → Operation → Cost Component model (ADR 006) once the MCP implements the tools.

## Threat model (must remain true)

- Company A tokens cannot be resolved or refreshed as Company B.
- Guessed, replayed, expired, or wrong-user OAuth state fails closed.
- Failed refresh marks `auth_expired` and keeps the last refresh token.
- Unauthenticated start/test/disconnect are 401.
- Callback with invalid state redirects to the portal error, never persists tokens.
- Public views show organisation name, dates, and scopes — never tokens or the Client Secret.
