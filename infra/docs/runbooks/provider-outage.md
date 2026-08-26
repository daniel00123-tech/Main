# Runbook: Provider outage

## Symptoms

- Connector degraded/error with provider timeout messages
- Multiple tenants affected for same provider (e.g. Xero API)
- MCP healthy but business-system tools fail

## Diagnosis

1. Confirm **Platform health** is operational (API, D1, gateway)
2. Check provider status page / API
3. Review whether failure is single-tenant (auth) vs multi-tenant (outage)

## Response

1. Document start time and scope
2. Do not mark INFRA as offline on System health for customer integration failures
3. Notify affected companies if prolonged
4. Pause acceptance testing until provider recovers

## Recovery

- Re-run test connection when provider green
- Backlog actions may need manual review (Action Engine)

## INFRA responsibilities

- Accurate status presentation
- No duplicate charges for failed provider calls (per pricing rules)
- Audit trail for support
