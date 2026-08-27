# Runbook: Company suspension

## When to suspend

- Billing dispute or abuse
- Security incident pending investigation
- Customer request for pause

## Procedure

1. Control Plane → **Companies** → company detail → set status **suspended**
2. Communicate to customer admin (out of band)

## Effects

- Chargeable AI operations and connector writes blocked
- Onboarding shows suspended problem
- Needs-attention critical item on dashboard
- Does not delete data or revoke tokens automatically

## Reactivation

1. Resolve root cause
2. Set status **active** (or **onboarding** if setup incomplete)
3. Verify wallet and MCP health before customer-facing comms

## Related

- [Wallet issue](./wallet-issue.md)
- [AI token compromised](./ai-token-compromised.md)
