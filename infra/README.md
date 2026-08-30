# INFRA

Multi-tenant control plane for business AI: companies, MCP gateway, connectors, permissions, wallet, automations, WhatsApp, quality.

**Current documentation (read these):**

- Repository entry: [`../AGENTS.md`](../AGENTS.md)
- Architecture: [`../docs/architecture/CURRENT_ARCHITECTURE.md`](../docs/architecture/CURRENT_ARCHITECTURE.md)
- Capabilities: [`../docs/CAPABILITY_MATRIX.md`](../docs/CAPABILITY_MATRIX.md)
- Runbook: [`../docs/DEVELOPMENT_RUNBOOK.md`](../docs/DEVELOPMENT_RUNBOOK.md)

## Layout

```
infra/
  migrations/                 # D1 control-plane schema
  packages/api                # Cloudflare Worker (infra-api)
  packages/web                # Admin + company portal
  packages/shared             # Types, catalogue, canonical URLs
  packages/xero-core          # Reusable Xero client/tools
  packages/caddington-mcp     # Snapshot + Xero inject for the external Caddington Worker
  scripts/cloud-agent-*.sh    # Idempotent local / Cloud Agent bootstrap
```

## Local development

From the **repository root**:

```bash
bash infra/scripts/cloud-agent-install.sh
cd infra
npm run dev          # API  http://localhost:8787
npm run dev:web      # Web  http://localhost:5173
```

Do not run `npm run download-base --workspace=@infra/caddington-mcp` unless you explicitly need Caddington build tests. That requires `CLOUDFLARE_API_TOKEN` and writes a gitignored production artifact.

## Historical docs

ADRs and sprint reports in [`docs/`](docs/) are useful history. If they disagree with the repository-root [`../docs/`](../docs/) directory, that directory and the code win.
