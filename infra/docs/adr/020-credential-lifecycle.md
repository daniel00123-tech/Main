# ADR 020 — Credential lifecycle

- **Status:** Accepted
- **Date:** 2026-08-25
- **Depends on:** ADR 019

## States

`not_configured` → `credentials_required` → `configuring` → `connected`

From connected: `auth_expired` · `rotation_required` · `revoked` · `error`

## Rotation

1. Encrypt the replacement first (if encryption fails, the previous ciphertext stays active)
2. Validate (when a provider test exists — none do yet, so auth stays `configuring`)
3. Atomically replace the ciphertext for the same `sec_…` reference
4. Retire the previous encrypted version to history
5. Audit `credential.rotated` / `connector.credentials_rotated` without values

Never reveal the previous secret. Suspension does **not** delete credentials.

## Revocation

Revoke wipes active and history ciphertext, keeps metadata, and marks the connector disconnected. Rollback of a revoked secret is not supported; failed rotation already preserves the last good version. See ADR 026.
