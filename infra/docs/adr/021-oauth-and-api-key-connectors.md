# ADR 021 — OAuth and API-key connector frameworks

- **Status:** Accepted
- **Date:** 2026-08-25
- **Depends on:** ADR 018, ADR 019, ADR 020

## OAuth

Start → hashed `state` + encrypted PKCE S256 verifier → provider → callback → validate tenant/user/expiry/replay → store tokens via SecretProvider → connected.

Xero is the first activated OAuth provider (ADR 027). Other OAuth catalogue entries still return `OAUTH_NOT_ACTIVATED`.

Security: state validation, CSRF, PKCE, tenant + user binding, single-use expiry, scope checks, no tokens in logs. The callback never trusts a company id supplied only by the browser.

## API key

Company admin enters credentials → SecretProvider.store → instance holds reference → test → connected.

Production POST of secret values succeeds only when `INFRA_CREDENTIAL_WRAPPING_KEY` is configured (ADR 026). Otherwise it returns `CREDENTIAL_SUBMISSION_DISABLED` (409).
