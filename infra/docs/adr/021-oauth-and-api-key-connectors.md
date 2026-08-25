# ADR 021 — OAuth and API-key connector frameworks

- **Status:** Accepted
- **Date:** 2026-08-25
- **Depends on:** ADR 018, ADR 019, ADR 020

## OAuth

Start → hashed `state` + PKCE S256 → provider → callback → validate tenant/user/expiry → (future) store tokens via SecretProvider → connected.

Xero is specified, not activated. Callbacks persist no tokens in this phase.

Security: state validation, CSRF, PKCE, tenant + user binding, scope checks, no tokens in logs.

## API key

Company admin enters credentials → SecretProvider.store → instance holds reference → test → connected.

Production POST of secret values returns `CREDENTIAL_SUBMISSION_DISABLED` (409).
