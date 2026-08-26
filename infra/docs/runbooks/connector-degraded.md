# Runbook: Connector degraded

## Symptoms

- Connector status **degraded** or **error**
- Sync failures; provider health unhealthy
- Needs-attention connector item

## Diagnosis

1. Portal → **Connections** → inspect last error message (customer-safe text only)
2. Distinguish: auth vs provider outage vs configuration incomplete
3. Check company MCP if connector is MCP-managed metadata

## Resolution

- **Auth**: follow [OAuth expired](./oauth-expired.md)
- **Provider outage**: wait; document; no INFRA platform incident
- **Config incomplete**: complete required fields; Save & Test
- **MCP-managed source**: fix upstream on company MCP (e.g. Drive sync)

## Verify

- Health returns healthy or connected
- Last successful sync timestamp updates when applicable

## Platform vs customer

One degraded customer connector does **not** mean INFRA API is down — check **Platform health** separately on System health page.
