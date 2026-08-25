# Caddington Business MCP Worker

Production Worker extended with Xero read tools via `@infra/xero-core` and the INFRA internal credential bridge.

## Build

```bash
npm run download-base   # snapshots current production worker (requires CLOUDFLARE_API_TOKEN)
npm run build           # injects Xero handlers into base worker → dist/worker.js
npm run deploy
```

## Secrets (names only)

- `MCP_AUTH_TOKEN` — must match INFRA `CADDINGTON_MCP_AUTH_TOKEN` for bridge + MCP auth
- `CADDINGTON_ADMIN_TOKEN` — existing admin routes
- Google Drive secrets — unchanged

## Vars (wrangler.toml)

- `INFRA_API_URL`
- `INFRA_MCP_ENVIRONMENT_ID` (`mcp_caddington_primary`)

Existing knowledge tools are preserved from the production base worker snapshot.
