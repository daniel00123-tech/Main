# ADR 026 — Production SecretProvider (envelope encryption)

- **Status:** Accepted
- **Date:** 2026-08-25
- **Depends on:** ADR 001, ADR 012, ADR 018, ADR 019, ADR 020, ADR 021
- **Supersedes in part:** ADR 019 “production submission disabled”

## Decision

INFRA now has a production `SecretProvider` that stores **ciphertext in D1** and the **wrapping key as a Cloudflare Worker secret**.

```
Company → Connector Instance → credential_ref (cred_…)
       → SecretProvider reference (sec_…)
       → AES-256-GCM ciphertext in D1
       → wrapping key INFRA_CREDENTIAL_WRAPPING_KEY (Worker secret, never D1)
```

INFRA stores encrypted connector credentials and control-plane metadata. INFRA does **not** become the company data warehouse. Business data remains:

```
Business systems → Company Business MCP / warehouse → INFRA control plane → AI client
```

Existing MCP Worker auth secrets (`CADDINGTON_MCP_AUTH_TOKEN`, HT/EL) stay as Worker secrets. They are not migrated into this table.

## Encryption

- Algorithm: **AES-256-GCM** via Web Crypto (`AES-GCM`, 256-bit key, 96-bit random nonce, 128-bit tag).
- One fresh nonce per encrypt. No custom cryptography.
- AAD binds `algorithm|key_version|companyId|purpose|connectorInstanceId|reference` so a ciphertext cannot be moved to another tenant row and decrypted.
- Payload is JSON (API-key fields or OAuth token set). Max 32 KiB.

## Key storage and versioning

- Current wrapping key: Worker secret `INFRA_CREDENTIAL_WRAPPING_KEY` (32 bytes as 64 hex chars or standard base64).
- Current version label: `INFRA_CREDENTIAL_KEY_VERSION` (default `v1`).
- Future key `v2`: set `INFRA_CREDENTIAL_KEY_VERSION=v2`, put the new material in `INFRA_CREDENTIAL_WRAPPING_KEY` (current) and/or `INFRA_CREDENTIAL_WRAPPING_KEY_V2`, and keep v1 material as `INFRA_CREDENTIAL_WRAPPING_KEY_V1` until re-encrypt completes.
- Each ciphertext row stores `key_version`. Decrypt uses the current Worker secret only for that current version; older versions use `INFRA_CREDENTIAL_WRAPPING_KEY_<VERSION>` only. Overwriting the current secret without keeping the previous versioned secret makes old rows unreadable (safe failure, no silent delete).
- If the wrapping key is missing, store/rotate stay disabled. The UI says “Secure credential storage is not configured.” No fake readiness.

## Lifecycle

**Store.** Validate company + instance + actor. Partition secret fields (schema `format: secret` plus defensive name matching). Encrypt. Persist `sec_…`. Create `credential_refs` (`cred_…`). Instance holds only `credential_ref_id`. Auth becomes `configuring`, not Connected, unless a real provider test exists (none do yet).

**Resolve.** Internal only (`resolveConnectorCredentialForExecution`). Requires authenticated company + instance relationship + reason. Decrypts for that execution and discards. No public GET returns plaintext. No long-lived plaintext cache.

**Rotate.** Encrypt the replacement first. If encryption fails, the previous ciphertext stays active. On success, copy the old ciphertext into `secret_ciphertext_history` (still encrypted) and atomically replace the active row. Same `sec_…` reference.

**Revoke.** Mark unusable, wipe active and history ciphertext, keep metadata, set connector `revoked`, audit without values. Ciphertext is removed rather than retained: rollback of a revoked secret is not supported; failed rotation already preserves the last good version.

## Who may see what

| Actor | Plaintext | Status / metadata |
| --- | --- | --- |
| Frontend / company user | Never (submit only) | Masked fields, last updated |
| Platform Admin | Never | Auth/sync status |
| General INFRA API | Never | Opaque refs |
| SecretProvider.resolve | Authorised same-company execution only | — |
| Company Business MCP | Only the credential for that company/connector, when INFRA grants it for an authorised execution | — |
| Other tenants | Never | Never |
| Audit / logs | Never | company, connector, ref, actor, result |

## Threat model (abridged)

- D1 dump without the Worker secret: ciphertext only.
- Guessed `sec_…` / `cred_…`: rejected unless the authenticated company owns both the instance and the ref.
- Moving ciphertext to another company row: AAD mismatch, decrypt fails closed.
- Tampered ciphertext/tag/nonce: decrypt fails closed, credential is not deleted.
- Wrong or missing key: safe error, no partial plaintext.
- Suspended/archived company: store/resolve denied.

## Recovery

1. Restore D1 from backup if rows were lost.
2. The wrapping key must still exist; without it, ciphertext is unreadable.
3. To rotate the wrapping key: introduce v2, re-encrypt active rows, verify resolve, then retire v1.

## Xero

This store can hold `{ accessToken, refreshToken, expiresAt, scopes, providerTenantId }`. Live Xero OAuth is still not activated (ADR 015 / 021).
