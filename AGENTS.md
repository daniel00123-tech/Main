# INFRA — Agent and developer entry point

Read this file first. It is the current source of truth for how to work on INFRA.

Before significant INFRA changes:

1. Read [docs/architecture/CURRENT_ARCHITECTURE.md](docs/architecture/CURRENT_ARCHITECTURE.md)
2. Read [docs/CAPABILITY_MATRIX.md](docs/CAPABILITY_MATRIX.md)
3. Read the relevant subsystem document (WhatsApp, quality, tenancy, runbook)
4. Inspect the actual code
5. Do **not** assume old PR titles, stacked WhatsApp V1–V4 branches, or chat prompts are current

Canonical docs live under [`docs/`](docs/README.md). Historical ADRs and sprint reports remain in [`infra/docs/`](infra/docs/) and are marked when superseded.

---

## What INFRA is

INFRA is a **multi-tenant business AI / MCP / automation platform**.

It is the control plane in front of staff-facing AI clients (ChatGPT, Claude) and channels (WhatsApp). It does not replace those clients. It owns identity, permissions, routing, metering, billing, connectors, automations, quality, and audit.

Company knowledge and business systems of record stay in **company Business MCPs** (Caddington MCP is the reference; HT/EL MCPs exist and are paused for deeper integration).

This GitHub repository (`daniel00123-tech/Main`) also contains unrelated Python automations at the repo root (`scripts/`). INFRA lives in `infra/`. Do not mix the two.

---

## Canonical production URLs

| Role | Canonical | Legacy (keep working during cutover) |
| --- | --- | --- |
| Portal | `https://app.infrastack.app` | `https://infra-web.pages.dev` |
| API | `https://api.infrastack.app` | `https://infra-api.daniel-dwyer123.workers.dev` |
| MCP | `https://mcp.infrastack.app/api/gateway/v1/mcp` | same path on the legacy API host |
| Public site | `https://infrastack.app` | — |

Prefer canonical hosts in new work. Do not set cookie `Domain=.infrastack.app`. `app.infrastack.app` uses host-only cookies.

Constants: `infra/packages/shared/src/platform/urls.ts`.

---

## Architecture (one screen)

```
AI client (ChatGPT / Claude)
  → https://mcp.infrastack.app/api/gateway/v1/mcp
  → infra-api (auth, permissions, wallet, audit)
  → company Business MCP (knowledge / tools) via service binding

WhatsApp
  → Meta Cloud API
  → POST /api/webhooks/whatsapp on infra-api
  → persist + greeting fast-lane
  → WHATSAPP_INBOUND_QUEUE
  → identity (E.164 → user → company → permissions)
  → conversational brain → MCP/tools → reply

Portal
  → https://app.infrastack.app  (Cloudflare Pages)
  → /api/* proxied to https://api.infrastack.app
```

Details: [docs/architecture/CURRENT_ARCHITECTURE.md](docs/architecture/CURRENT_ARCHITECTURE.md).

---

## Repository map

| Path | Package | New work belongs here when… |
| --- | --- | --- |
| `infra/packages/api` | `@infra/api` | Control-plane Worker: auth, gateway, WhatsApp, automations, billing, OCR, quality |
| `infra/packages/web` | `@infra/web` | Admin control panel + reusable company portal |
| `infra/packages/shared` | `@infra/shared` | Types, connector catalogue, URL constants, email identity, permission presets |
| `infra/packages/xero-core` | `@infra/xero-core` | Reusable Xero client/tools (used by API and injected into Caddington MCP) |
| `infra/packages/caddington-mcp` | `@infra/caddington-mcp` | Build pipeline that snapshots the **external** Caddington Worker and injects Xero. Not the full MCP source. |
| `infra/migrations` | D1 | Control-plane schema. Never invent tenant-unowned data. |
| `infra/docs` | — | Historical ADRs, UAT reports, operational runbooks |
| `docs/` | — | **Current** project guidance (this consolidation) |
| `scripts/`, `tests/` | — | Unrelated Python automations (Aquilo / Dandara). Leave them alone unless asked. |

---

## Local / Cloud Agent commands

Exact commands: [docs/DEVELOPMENT_RUNBOOK.md](docs/DEVELOPMENT_RUNBOOK.md).

```bash
# First install / Cloud Agent install (idempotent, includes D1 migrate+seed)
bash infra/scripts/cloud-agent-install.sh

# Or manually:
cd infra
npm install
# then the install script's D1 sequence — do not blindly migrate→seed on a fresh D1
npm run dev          # API  http://localhost:8787
npm run dev:web      # Web  http://localhost:5173
```

Local portal login (from `infra/packages/api/.dev.vars.example`):

- Email: `admin@infra.local`
- Password: `ChangeMeBeforeProduction!`

Health: `GET http://localhost:8787/health` and `/ready`.

Cloud Agent environment is repository-managed: [`.cursor/environment.json`](.cursor/environment.json). It installs deps, provisions local D1, and starts API + web on ports `8787` / `5173`.

---

## Rules (do not violate)

- **Cursor is development tooling, never runtime.** WhatsApp, MCP, automations, and quality loop must not call Cursor.
- **Preserve tenant isolation.** Every query, tool call, knowledge hit, and WhatsApp turn is company-scoped.
- **Preserve permissions.** Role presets + per-company grants. Platform admin is not a tenant user.
- **Protected writes go through the Action Engine** (plan → confirm → approve → execute). Direct MCP `xero_create_*` tools stay blocked (`DIRECT_MCP_FINANCIAL_WRITES_BLOCKED`).
- **Never invent provider costs.** Missing cost is `unavailable`, not £0.
- **Never commit secrets** or production Worker artifacts (`vendor/base.worker.js` is gitignored).
- **Prefer canonical `infrastack.app` domains.**
- **Do not rebuild completed capabilities.** Check the [capability matrix](docs/CAPABILITY_MATRIX.md) and [project status](docs/PROJECT_STATUS.md) first.
- **Do not download Caddington `base.worker.js` unless you explicitly need those tests.** Requires secret `CLOUDFLARE_API_TOKEN`.

---

## Testing expectations

Full mapping: [docs/TEST_MATRIX.md](docs/TEST_MATRIX.md).

| You changed | Run |
| --- | --- |
| WhatsApp | `@infra/api` tests matching `whatsapp*` + API build |
| Xero | `@infra/xero-core` + `@infra/api` Xero/action-engine tests |
| Web / portal | `@infra/web` test + `npm run build --workspace=@infra/web` + browser check if UI |
| Shared types / catalogue / URLs | `@infra/shared` + dependent API/web tests |
| Quality loop | `quality-loop` + `quality-auditor` API tests |
| Migrations / seed / env | install script twice (idempotence) + `/health` `/ready` |
| Unrelated Python scripts | `python3 -m unittest` from repo root |
| Monorepo-wide confidence | `cd infra && npm run test` (Caddington 6 failures without `base.worker.js` are expected) |

---

## Deployment expectations

- **API / MCP / WhatsApp / queues / cron:** `cd infra/packages/api && npm run deploy` (Wrangler → Worker `infra-api`). Apply D1 migrations to production D1 separately.
- **Web / portal:** Cloudflare Pages project for `app.infrastack.app` (build `@infra/web`). `/api/*` is proxied to `https://api.infrastack.app`.
- **Caddington MCP:** only when changing the inject/build pipeline: `npm run download-base --workspace=@infra/caddington-mcp` then `npm run deploy --workspace=@infra/caddington-mcp`. Requires `CLOUDFLARE_API_TOKEN`.
- Do not deploy from Cloud Agent setup. Do not put production secrets in Git.

---

## Current known limitations

See [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md) and the [capability matrix](docs/CAPABILITY_MATRIX.md). Highlights:

- WhatsApp is implemented through V4.2; **live Meta inbound UAT is still outstanding** (a real `wamid.HBg…` row from the linked phone).
- Connector catalogue still labels WhatsApp `coming_soon` even though the channel runtime exists.
- Caddington MCP source is **not** in this repo; only a snapshot/inject pipeline.
- HT / EL Business MCPs are registered and paused for deeper integration.
- Company data warehouse (ADR 030) is planning only.
- Stripe live Caddington payment-acceptance PRs (#338–#342) are **not** in this branch.
- Portal UX PR #361 and Xero OCR close-out PR #362 conflict with this branch and were **not** blindly merged.

---

## Canonical document index

| Document | Use it for |
| --- | --- |
| [docs/README.md](docs/README.md) | Index |
| [docs/architecture/CURRENT_ARCHITECTURE.md](docs/architecture/CURRENT_ARCHITECTURE.md) | What is running today |
| [docs/CAPABILITY_MATRIX.md](docs/CAPABILITY_MATRIX.md) | Production vs partial vs planned |
| [docs/DEVELOPMENT_RUNBOOK.md](docs/DEVELOPMENT_RUNBOOK.md) | Exact commands |
| [docs/PRODUCTION_SERVICES.md](docs/PRODUCTION_SERVICES.md) | Workers, bindings, providers |
| [docs/TENANCY_AND_SECURITY.md](docs/TENANCY_AND_SECURITY.md) | Isolation, permissions, approvals |
| [docs/channels/WHATSAPP.md](docs/channels/WHATSAPP.md) | Current WhatsApp architecture (not V1–V4) |
| [docs/quality/CONTINUOUS_QUALITY_LOOP.md](docs/quality/CONTINUOUS_QUALITY_LOOP.md) | Evaluator, cadence, approval, rollback |
| [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md) | Ready / UAT / debt / next |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Durable architectural decisions |
| [docs/TEST_MATRIX.md](docs/TEST_MATRIX.md) | Subsystem → tests |
| [docs/PR_RECONCILIATION.md](docs/PR_RECONCILIATION.md) | Stacked PRs vs this branch |
| [infra/docs/adr/README.md](infra/docs/adr/README.md) | Historical ADRs |
