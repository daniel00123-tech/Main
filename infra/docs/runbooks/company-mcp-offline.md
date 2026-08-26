# Runbook: Company MCP offline

## Symptoms

- Dashboard **Needs attention**: Business MCP offline / degraded / unreachable
- AI client errors when calling tools
- Company onboarding problem: **Business MCP needs attention**

## Diagnosis

1. Control Plane → **System health** → **Customer integrations** → affected MCP
2. Run **Health check** on MCP environment row
3. Check Cloudflare Worker status for the company MCP (outside INFRA if external)
4. Verify `authSecretRef` Worker secret exists on `infra-api` and matches MCP `MCP_AUTH_TOKEN`

## Resolution

| Cause | Action |
| --- | --- |
| Worker deleted / wrong URL | Update endpoint URL or redeploy MCP; re-register if needed |
| Auth token mismatch | Rotate MCP token; update Worker secret; confirm secret ref name unchanged |
| MCP code error | Fix/deploy company MCP; health should recover on next probe |
| Network / CF outage | Wait; INFRA platform health may still be OK |

## Verify

- MCP status returns `healthy`
- Non-destructive `system_health` via AI connection succeeds
- Audit shows successful MCP health check

## Escalation

- Do not suspend company unless billing abuse; suspension blocks customer operations entirely
- Document correlation ID from failed gateway request for support trace
