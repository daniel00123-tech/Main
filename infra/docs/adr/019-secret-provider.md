# ADR 019 — Secret Provider architecture

- **Status:** Accepted
- **Date:** 2026-08-25
- **Depends on:** ADR 001, ADR 012

## Options evaluated

| Option | Multi-tenant scale | Cost | Automation | Blast radius | Verdict |
| --- | --- | --- | --- | --- | --- |
| Plaintext in D1 | Works | Free | Easy | Catastrophic | Forbidden |
| Base64 / app-level xor in D1 | Works | Free | Easy | Catastrophic | Forbidden |
| Ciphertext in D1 + key also in D1 | Works | Free | Easy | Catastrophic | Forbidden |
| Worker `wrangler secret` per credential | No (hundreds of companies) | Free | Poor | Per-worker | Keep for INFRA/MCP *platform* secrets only |
| Cloudflare Secrets Store | Yes if product is enabled | Likely paid | API | Per-secret | Candidate — needs account enablement |
| External vault (e.g. Secrets Manager) | Yes | Paid + egress | Good | Per-policy | Candidate for later |
| Envelope encryption: ciphertext in D1, wrapping key in a Worker secret / KMS, never beside the key | Yes | Low | Good | Per-key | **Preferred when we implement storage** |

## Decision

Application code uses `SecretProvider` (`store`, `resolve`, `rotate`, `revoke`, `exists`). Connector instances hold only an opaque reference.

Production submission uses envelope encryption when `INFRA_CREDENTIAL_WRAPPING_KEY` is configured (ADR 026). If that Worker secret is missing, store/rotate stay disabled. Tests use an in-memory provider or a test wrapping key. Existing MCP auth continues to resolve named Worker secret *bindings* and is not migrated into D1.

Frontend, logs, audit, URLs, and ordinary D1 rows never receive secret values.

## Who may resolve

- Frontend: never
- Platform Admin UI: status only
- INFRA general API: never returns values
- Secret service: only for an authorised same-company reason
- Company Business MCP: only credentials granted to that company/connector
- Other companies: never
