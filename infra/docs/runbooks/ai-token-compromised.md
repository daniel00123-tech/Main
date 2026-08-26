# Runbook: AI token compromised

## Symptoms

- Suspected leak of ChatGPT/Claude service identity token
- Unexpected usage from unknown source client
- Customer report of unauthorised AI access

## Immediate actions

1. Portal → **AI connections** → **Revoke** affected client identity
2. Control Plane → verify no other active tokens for company unless intentional
3. If platform admin token leaked: rotate `SESSION_SECRET` (maintenance window — separate change control)

## Follow-up

1. Create new AI connection; token shown **once** — configure client securely
2. Review audit log and usage for period of exposure
3. Suspend company only if ongoing abuse cannot be stopped by revoke alone

## Verify

- Old token returns 401 on gateway
- New token works for non-destructive health check
- `lastUsedAt` only reflects legitimate client

## Do not

- Paste tokens into tickets, Slack, or audit-visible fields
- Re-display revoked token prefix as if still valid
