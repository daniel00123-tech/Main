# Caddington Business MCP Worker

Production Worker extended with Xero read tools via `@infra/xero-core` and the INFRA internal credential bridge.

## Build (idempotent)

The production knowledge/admin MCP is snapshotted from Cloudflare, **stripped of any prior Xero injection**, then rebuilt with a single fresh `@infra/xero-core` inject block marked `INFRA_XERO_INJECT_BEGIN/END`.

```bash
npm run download-base   # snapshots production worker + strips prior Xero inject (requires CLOUDFLARE_API_TOKEN)
npm run build           # injects Xero handlers once → dist/worker.js (safe to rerun)
npm run deploy
```

Re-running `npm run build` on the same `vendor/base.worker.js` must not duplicate symbols. Regression tests live in `scripts/build-worker.test.mjs`.

**Schema rule:** all injected tool `inputSchema` values must be Zod v4 raw shapes (from the base worker's `external_exports`). Mixed JSON Schema objects inside a Zod raw shape break downstream `tools/list` (MCP SDK cannot serialise them).

## Secrets (names only)

- `MCP_AUTH_TOKEN` — must match INFRA `CADDINGTON_MCP_AUTH_TOKEN` for bridge + MCP auth
- `CADDINGTON_ADMIN_TOKEN` — existing admin routes
- Google Drive secrets — unchanged

## Vars (wrangler.toml)

- `INFRA_API_URL`
- `INFRA_MCP_ENVIRONMENT_ID` (`mcp_caddington_primary`)

Existing knowledge tools are preserved from the production base worker snapshot.
