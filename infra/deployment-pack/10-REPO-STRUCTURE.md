# Repository Structure

## Monorepo layout

```
Main/                          ← GitHub repository root
├── infra/                     ← INFRA project (all new work here)
│   ├── deployment-pack/       ← This documentation pack
│   ├── docs/                  ← Live design docs (same content as pack)
│   ├── migrations/            ← D1 SQL migrations
│   │   └── 0001_control_plane.sql
│   ├── packages/
│   │   ├── shared/            ← Types, connector catalogue, role presets
│   │   ├── api/               ← Cloudflare Worker (control plane API)
│   │   └── web/               ← React admin + company portal UI
│   ├── scripts/               ← Screenshot/walkthrough capture scripts
│   ├── package.json           ← npm workspaces root
│   └── README.md
├── scripts/                   ← Legacy automations (DO NOT MODIFY for INFRA)
└── tests/                     ← Legacy tests
```

---

## Key code locations

| What | Path |
| --- | --- |
| API routes | `infra/packages/api/src/index.ts` |
| Control plane services | `infra/packages/api/src/services/` |
| D1 seed data | `infra/packages/api/src/seed.sql` |
| Worker config | `infra/packages/api/wrangler.toml` |
| Connector catalogue | `infra/packages/shared/src/connectors/catalogue.ts` |
| Role presets | `infra/packages/shared/src/permissions/role-presets.ts` |
| Platform admin UI | `infra/packages/web/src/pages/` |
| Company portal UI | `infra/packages/web/src/portal/` |
| Mock data (prototype) | `infra/packages/web/src/mock-data.ts` |

---

## npm commands

```bash
cd infra

npm install                  # Install all packages
npm run dev                  # API on localhost:8787
npm run dev:web              # UI on localhost:5173
npm run db:migrate:local     # Apply D1 migrations locally
npm run db:seed:local        # Seed demo companies
npm test                     # Run tests
npm run typecheck            # TypeScript check
npm run build                # Build all packages
```

---

## Deployment commands

```bash
# API (production)
cd infra/packages/api
wrangler deploy

# UI (production)
cd infra/packages/web
npm run build
wrangler pages deploy dist --project-name=infra-web

# D1 (production)
wrangler d1 migrations apply infra-control-plane --remote
```

---

## Git branch

Current INFRA work: `cursor/infra-platform-v0-1-d3d8`  
PR: #286 on `daniel00123-tech/Main`

---

## What not to touch

- `scripts/bigchange_*.py` — legacy automations
- Existing Caddington MCP codebase — register in INFRA only, do not migrate in v0.1
- No credentials from Nirvana, Aquilo, Urban Maintenance

---

## Adding new features

| Feature | Where to add |
| --- | --- |
| New connector definition | `packages/shared/src/connectors/catalogue.ts` |
| New API endpoint | `packages/api/src/index.ts` + service |
| New D1 table | `migrations/000X_name.sql` |
| New admin page | `packages/web/src/pages/` |
| New portal page | `packages/web/src/portal/` |
| New role preset | `packages/shared/src/permissions/role-presets.ts` |
