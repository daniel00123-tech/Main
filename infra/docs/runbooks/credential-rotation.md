# Runbook: Credential rotation

## Scope

- INFRA-stored connector credentials (encrypted in D1 via `SecretProvider`)
- MCP downstream auth tokens (Cloudflare Worker secrets)
- AI service identity tokens (revoke + recreate)

## Connector credentials (INFRA OAuth / API key)

1. Portal → **Connections** → connector → **Rotate credentials**
2. Enter new values; Save & Test
3. Old ciphertext replaced; never logged in audit plaintext

## MCP auth token

1. Generate new token on company MCP Worker
2. Update Worker secret referenced by `authSecretRef`
3. No D1 change if ref name unchanged
4. Run MCP health check from Control Plane

## AI service identity

1. Revoke old identity
2. Create new connection; configure client with one-time token

## Verify

- Test connection / health check passes
- No secrets in API responses, UI, or customer-visible errors

## Prerequisites

- `INFRA_CREDENTIAL_WRAPPING_KEY` must be set for INFRA credential storage
