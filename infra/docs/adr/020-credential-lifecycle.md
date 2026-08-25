# ADR 020 — Credential lifecycle

- **Status:** Accepted
- **Date:** 2026-08-25
- **Depends on:** ADR 019

## States

`not_configured` → `credentials_required` → `configuring` → `connected`

From connected: `auth_expired` · `rotation_required` · `revoked` · `error`

## Rotation

1. Store the new secret
2. Validate (when a provider exists)
3. Atomically switch the instance reference
4. Retire the old secret
5. Audit `connector.credentials_rotated` without values

Never reveal the previous secret. Suspension does **not** delete credentials.
