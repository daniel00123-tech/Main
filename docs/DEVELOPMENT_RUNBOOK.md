# INFRA development runbook

Canonical Cloud Agent setup is [`.cursor/environment.json`](../.cursor/environment.json) plus [`infra/scripts/cloud-agent-install.sh`](../infra/scripts/cloud-agent-install.sh). Do not add a second competing bootstrap.

Node 20+ (Cloud Agent image is Node 22). Wrangler talks to **local** D1/miniflare unless you explicitly deploy.

## First install (local or Cloud Agent)

```bash
bash infra/scripts/cloud-agent-install.sh
```

The script is idempotent. It:

1. `npm install` in `infra/` (`--prefer-offline --no-audit --no-fund`)
2. Copies `infra/packages/api/.dev.vars.example` → `.dev.vars` if missing (never overwrites)
3. Provisions local D1 (see fresh-D1 note below)
4. Seeds `infra/packages/api/src/seed.sql`

It does **not** download `caddington-mcp/vendor/base.worker.js` and does **not** start servers.

### Fresh-D1 migration / seed handling

Documented `migrate → seed` fails on an empty database.

Migrations `0008` and `0033` insert rows that FK-reference `co_caddington` / `co_ht` / `co_el`, but those companies are created in `src/seed.sql`, which runs after migrations. The first `wrangler d1 migrations apply` therefore stops at `0008` with a foreign-key error.

The install script’s sequence (do not “simplify” this away):

1. `wrangler d1 migrations apply infra-control-plane --local` (allow failure)
2. `INSERT OR IGNORE` the three base companies
3. Apply remaining migrations
4. `npm run db:seed:local`

Re-runs are safe. Do not rewrite committed migrations to paper over this.

## Cloud Agent startup

After install, `.cursor/environment.json` starts two terminals:

| Terminal | Command | URL |
| --- | --- | --- |
| `infra-api` | `cd infra/packages/api && WRANGLER_SEND_METRICS=false CI=1 npm run dev` | http://localhost:8787 |
| `infra-web` | `cd infra/packages/web && npm run dev -- --host` | http://localhost:5173 |

`start` (`infra/scripts/cloud-agent-start.sh`) only re-provisions D1 if the local DB is missing companies. It does not launch servers.

Ports exposed: `5173`, `8787`.

## Local API / web (manual)

```bash
cd infra
npm run dev          # API
npm run dev:web      # Vite; proxies /api and /health → 127.0.0.1:8787
```

## Local login

From `.dev.vars.example` (bootstrapped into `.dev.vars`):

| Field | Value |
| --- | --- |
| Email | `admin@infra.local` |
| Password | `ChangeMeBeforeProduction!` |
| Portal | http://localhost:5173 |

`bootstrapPlatformAdminIfNeeded` creates that user on first API request when the env vars are set.

## D1, migrations, seed

```bash
cd infra
npm run db:migrate:local    # wrangler apply --local (fails on fresh DB — use the install script)
npm run db:seed:local
```

Production D1 name: `infra-control-plane` (see [PRODUCTION_SERVICES.md](PRODUCTION_SERVICES.md)). Never point wrangler `--local` commands at production.

Migrations live in `infra/migrations/` (`0001`–`0045` on this branch).

## Tests

```bash
cd infra
npm run test --workspace=@infra/shared
npm run test --workspace=@infra/xero-core
npm run test --workspace=@infra/api
npm run test --workspace=@infra/web
npm run test                            # all workspaces
```

Caddington MCP tests that read `vendor/base.worker.js` fail until:

```bash
# requires CLOUDFLARE_API_TOKEN — production-only; do not run by default
npm run download-base --workspace=@infra/caddington-mcp
```

Python automations (repo root, not INFRA):

```bash
python3 -m unittest
```

Which suite to run: [TEST_MATRIX.md](TEST_MATRIX.md).

## Builds

```bash
cd infra
npm run build --workspace=@infra/web
npm run build --workspaces --if-present
```

`@infra/api` is deployed as TypeScript via Wrangler (no separate production bundle step).
`@infra/caddington-mcp` build requires `download-base` first.

## Wrangler

```bash
cd infra/packages/api
npx wrangler dev                  # same as npm run dev
npx wrangler d1 migrations list infra-control-plane --local
```

Keep `WRANGLER_SEND_METRICS=false` and `CI=1` in Cloud Agents (non-interactive).

## Safe deployments

Do **not** deploy from environment setup or from a Cloud Agent unless a human explicitly asked.

```bash
# API Worker (infra-api) — production
cd infra/packages/api
npx wrangler d1 migrations apply infra-control-plane   # production D1, no --local
npm run deploy

# Web / portal — Cloudflare Pages build of @infra/web
# VITE_API_BASE must be empty in production (same-origin /api proxy)

# Caddington MCP — only if changing inject/build
npm run download-base --workspace=@infra/caddington-mcp
npm run deploy --workspace=@infra/caddington-mcp
```

Never commit `.dev.vars`, `.env`, or `vendor/base.worker.js`.

## Environment variables

Names and placeholders: [../.env.example](../.env.example) and [`infra/packages/api/.dev.vars.example`](../infra/packages/api/.dev.vars.example).

| Class | Where |
| --- | --- |
| Required local | `.dev.vars.example` — session + admin bootstrap + empty portal cookie domain |
| Optional integration | commented names in `.dev.vars.example` |
| Production-only | wrangler secrets listed in [PRODUCTION_SERVICES.md](PRODUCTION_SERVICES.md) |

## Caddington MCP special case

The live Caddington Worker is **external**. This repo only snapshots it and injects Xero.

- Artifact: `infra/packages/caddington-mcp/vendor/base.worker.js` (**gitignored**)
- Download: `npm run download-base --workspace=@infra/caddington-mcp`
- Secret name: `CLOUDFLARE_API_TOKEN`
- Standard Cloud Agent / local API+web **must work without that token**
