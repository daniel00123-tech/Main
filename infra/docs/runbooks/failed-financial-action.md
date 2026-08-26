# Runbook: Failed financial action

## Context

Financial writes (e.g. Xero draft invoice) are orchestrated by the **Action Engine** (separate workstream). This runbook covers operator response only.

## Symptoms

- Portal **Actions** shows failed or stuck plan
- Audit: action execution failure
- Customer report of invoice/payment not created

## Diagnosis

1. Portal → **Actions** (when plans exist) or audit for action execution events
2. Trace correlation ID: interaction → operation → MCP call
3. Check: company not suspended; wallet sufficient; connector auth valid; write flag policy

## Resolution

| Cause | Action |
| --- | --- |
| OAuth expired | [OAuth expired](./oauth-expired.md) |
| Insufficient wallet | [Wallet issue](./wallet-issue.md) |
| MCP offline | [Company MCP offline](./company-mcp-offline.md) |
| Provider rejection | Review customer-safe error; fix data in source system |
| Write not enabled | Expected in current phase — do not enable without approval |

## Verify

- Dry-run or read-back confirms intended state (when writes enabled)
- Audit shows outcome and actor

## Do not

- Retry destructive operations blindly
- Enable `FINANCIAL_WRITES_ENABLED` without change control
