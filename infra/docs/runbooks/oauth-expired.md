# Runbook: OAuth expired (connector)

## Symptoms

- Portal/Control Plane: connector auth status **Authentication expired**
- Needs-attention item for connector
- Business-system tools fail with auth errors

## Diagnosis

1. Portal → **Connections** → affected connector
2. Confirm status is not fake "Connected" — check `authStatus` and last error
3. Review audit for `connector.oauth` / disconnect events

## Resolution

1. Portal → **Connections** → **Reconnect** / re-run OAuth flow
2. If refresh token revoked at provider: full re-authorisation
3. For API-key connectors: **Rotate credentials** via Save & Test (requires credential storage enabled)

## Verify

- Auth status `connected`
- Test connection succeeds (non-destructive)
- Next tool call via MCP succeeds

## Prevention

- Document token lifetime per provider (Xero, etc.)
- Monitor Needs attention dashboard weekly
