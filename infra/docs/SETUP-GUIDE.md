# INFRA — Setup & Go-Live Guide

> **Historical go-live notes.** Current commands and domains: [`../../docs/DEVELOPMENT_RUNBOOK.md`](../../docs/DEVELOPMENT_RUNBOOK.md) and [`../../docs/PRODUCTION_SERVICES.md`](../../docs/PRODUCTION_SERVICES.md). Canonical hosts are `*.infrastack.app`, not the workers.dev examples in this file.

Use this document step-by-step (including with ChatGPT) to host INFRA on Cloudflare, attach a domain, and bring the platform live. It assumes you are starting from the `infra/` monorepo in the **Main** GitHub repository.

**Estimated components:** Cloudflare account, domain, GitHub, Stripe (test mode), optional Cursor for development.

---

## Table of contents

1. [What you are building](#1-what-you-are-building)
2. [Architecture recap](#2-architecture-recap)
3. [Prerequisites checklist](#3-prerequisites-checklist)
4. [Domain & DNS plan](#4-domain--dns-plan)
5. [Cloudflare account setup](#5-cloudflare-account-setup)
6. [Create D1 database (control plane)](#6-create-d1-database-control-plane)
7. [Deploy the INFRA API (Worker)](#7-deploy-the-infra-api-worker)
8. [Deploy the admin UI (Pages)](#8-deploy-the-admin-ui-pages)
9. [Environment variables & secrets](#9-environment-variables--secrets)
10. [Run database migrations & seed](#10-run-database-migrations--seed)
11. [Stripe test mode](#11-stripe-test-mode)
12. [Register Caddington MCP (first live connection)](#12-register-caddington-mcp-first-live-connection)
13. [Company portal & auth (next phase)](#13-company-portal--auth-next-phase)
14. [Cursor knowledge bridge (next phase)](#14-cursor-knowledge-bridge-next-phase)
15. [Ongoing operations](#15-ongoing-operations)
16. [Troubleshooting](#16-troubleshooting)
17. [Phase checklist summary](#17-phase-checklist-summary)

---

## 1. What you are building

| Component | URL (example) | Purpose |
| --- | --- | --- |
| **Platform admin** | `https://admin.infra.yourdomain.com` | You see all companies |
| **Company portal** | `https://app.infra.yourdomain.com` | EL/HT/Caddington see own company |
| **Control plane API** | `https://api.infra.yourdomain.com` | Workers API + webhooks |
| **Company MCPs** | `https://mcp-el.infra.yourdomain.com` etc. | Per-company AI tools (later) |

**v0.1 live scope:**
- Control plane API on Cloudflare Workers + D1
- Admin + company portal on Cloudflare Pages
- Caddington MCP registered (external, monitored)
- Stripe test-mode top-ups
- Usage metering + prepaid credits
- Developer-wired connectors (Cursor); self-service “Connect now” in v0.2

---

## 2. Architecture recap

```
Staff → ChatGPT / Claude / WhatsApp (future)
           ↓
    Company MCP (BigChange, knowledge, etc.)
           ↓
    INFRA (permissions · metering · billing · audit)
           ↓
    Business systems (BigChange, Commusoft, Xero, Drive)

Developer → Cursor → builds MCP/connectors → INFRA API
           ↓
    Cursor bridge (escalation when AI/MCP unsure)
```

**Host on Cloudflare** (proven by Caddington MCP stack): Workers, D1, Pages, R2, Vectorize, Queues, Cron.

**Do not use** AWS/Azure/Firebase unless there is a compelling reason.

---

## 3. Prerequisites checklist

Before starting, create or confirm access to:

- [ ] **GitHub** — repository with `infra/` folder (e.g. `daniel00123-tech/Main`)
- [ ] **Cloudflare account** — https://dash.cloudflare.com/sign-up
- [ ] **Domain name** — e.g. `yourdomain.com` (registrar can be Cloudflare, Namecheap, etc.)
- [ ] **Stripe account** — test mode for v0.1 — https://dashboard.stripe.com/register
- [ ] **Node.js 20+** on your dev machine — https://nodejs.org
- [ ] **Wrangler CLI** — installed via `npm install -g wrangler`
- [ ] **Cursor** — for development and Cursor bridge (later)

**Security:** INFRA must have **no connection** to legacy Nirvana, Aquilo, or Urban Maintenance credentials or live systems.

---

## 4. Domain & DNS plan

Pick a subdomain strategy. Example if your domain is `example.com`:

| Subdomain | Points to | Service |
| --- | --- | --- |
| `api.infra.example.com` | Cloudflare Worker | Control plane API |
| `admin.infra.example.com` | Cloudflare Pages | Platform admin UI |
| `app.infra.example.com` | Cloudflare Pages | Company portal |
| `mcp-caddington.infra.example.com` | External / future Worker | Caddington MCP (existing) |

### Steps

1. Add your domain to Cloudflare (DNS → Add site).
2. Update nameservers at your registrar to Cloudflare’s NS records.
3. Wait for DNS propagation (usually minutes to hours).
4. Enable **SSL/TLS → Full (strict)** for all subdomains.

You do **not** need separate servers — Cloudflare hosts Workers and Pages.

---

## 5. Cloudflare account setup

### 5.1 Install and login Wrangler

```bash
npm install -g wrangler
wrangler login
```

Browser opens → authorize Cloudflare.

### 5.2 Create Cloudflare API token (optional, for CI)

Dashboard → My Profile → API Tokens → Create Token → **Edit Cloudflare Workers** template.

Store token securely — never commit to git.

### 5.3 Note your Account ID

Dashboard → any zone → Overview → **Account ID** (right column). Needed for some CLI commands.

---

## 6. Create D1 database (control plane)

From your machine:

```bash
cd infra/packages/api
wrangler d1 create infra-control-plane
```

Output includes:

```
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Copy this ID into `infra/packages/api/wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "infra-control-plane"
database_id = "PASTE_YOUR_DATABASE_ID_HERE"
migrations_dir = "../../migrations"
```

Apply migrations to **remote** D1:

```bash
cd infra
npm install
npm run db:migrate:local   # test locally first
cd packages/api
wrangler d1 migrations apply infra-control-plane --remote
```

Seed demo companies (optional for production — use a sanitized seed):

```bash
wrangler d1 execute infra-control-plane --remote --file=./src/seed.sql
```

---

## 7. Deploy the INFRA API (Worker)

### 7.1 Configure production wrangler.toml

Add routes and production vars to `infra/packages/api/wrangler.toml`:

```toml
name = "infra-api"
main = "src/index.ts"
compatibility_date = "2025-02-14"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "infra-control-plane"
database_id = "YOUR_D1_DATABASE_ID"
migrations_dir = "../../migrations"

[vars]
ENVIRONMENT = "production"

# After first deploy, add custom domain in Cloudflare dashboard
# Workers → infra-api → Settings → Domains & Routes
# Route: api.infra.example.com/*
```

### 7.2 Set secrets (never in wrangler.toml plaintext)

```bash
cd infra/packages/api

# Stripe (test mode first)
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET

# Cursor bridge (when implemented)
wrangler secret put CURSOR_BRIDGE_SECRET

# Platform admin session signing
wrangler secret put SESSION_SECRET
```

### 7.3 Deploy

```bash
cd infra/packages/api
npm run deploy
# or: wrangler deploy
```

### 7.4 Attach custom domain

Cloudflare Dashboard → **Workers & Pages** → **infra-api** → **Settings** → **Domains & Routes** → **Add** → `api.infra.example.com`

Verify:

```bash
curl https://api.infra.example.com/health
# Expected: {"status":"ok","environment":"production",...}
```

---

## 8. Deploy the admin UI (Pages)

### Option A — Cloudflare Pages (recommended)

1. Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. Select GitHub repo `Main`
3. **Root directory:** `infra/packages/web`
4. **Build command:** `npm run build`
5. **Build output directory:** `dist`
6. **Environment variables:**
   - `VITE_API_BASE` = `https://api.infra.example.com`

7. Deploy → add custom domains:
   - `admin.infra.example.com` (admin app — route `/` for platform admin)
   - `app.infra.example.com` (company portal — same build, or split later)

### Option B — Manual deploy via Wrangler

```bash
cd infra/packages/web
npm run build
wrangler pages deploy dist --project-name=infra-web
```

### Local development (your machine)

```bash
cd infra
npm install
npm run dev          # API → localhost:8787
npm run dev:web      # UI  → localhost:5173
```

Note: `localhost` on your PC only works if **you** run the dev servers locally. The cloud agent VM is separate.

---

## 9. Environment variables & secrets

| Name | Where | Purpose |
| --- | --- | --- |
| `ENVIRONMENT` | Worker var | `production` / `development` |
| `STRIPE_SECRET_KEY` | Worker secret | Stripe test/live secret key |
| `STRIPE_WEBHOOK_SECRET` | Worker secret | Webhook signature verification |
| `SESSION_SECRET` | Worker secret | Admin/portal session JWT |
| `CURSOR_BRIDGE_SECRET` | Worker secret | Cursor ↔ INFRA bridge auth |
| `VITE_API_BASE` | Pages env | API URL for frontend |

**Never store:** card numbers, CVV, connector passwords, raw BigChange credentials in D1 or git.

Credentials → Cloudflare Workers Secrets or secret store → D1 holds `secret_ref` only.

---

## 10. Run database migrations & seed

Every schema change:

```bash
# 1. Add migration file: infra/migrations/0002_xxx.sql
# 2. Test locally
cd infra && npm run db:migrate:local

# 3. Apply remote
cd packages/api && wrangler d1 migrations apply infra-control-plane --remote
```

Demo tenants (Caddington, HT, EL) are in `infra/packages/api/src/seed.sql`.

---

## 11. Stripe test mode

### 11.1 Stripe dashboard setup

1. Dashboard → ensure **Test mode** toggle is ON
2. Developers → **API keys** → copy **Secret key** (`sk_test_...`)
3. Developers → **Webhooks** → Add endpoint:
   - URL: `https://api.infra.example.com/webhooks/stripe`
   - Events: `checkout.session.completed`, `payment_intent.succeeded`
4. Copy **Webhook signing secret** (`whsec_...`)

### 11.2 Store in Worker

```bash
wrangler secret put STRIPE_SECRET_KEY   # sk_test_...
wrangler secret put STRIPE_WEBHOOK_SECRET
```

### 11.3 Test flow

1. EL portal → Billing → Top up £50 (test)
2. Pay with Stripe test card `4242 4242 4242 4242`
3. Webhook fires → INFRA credits account → ledger entry
4. **Never credit on browser success alone** — webhook required

---

## 12. Register Caddington MCP (first live connection)

**Do not modify** the existing Caddington MCP codebase in v0.1.

1. Platform admin → MCP Environments → Register:
   - Company: Caddington Holdings
   - Endpoint: your real Caddington MCP URL
   - Health endpoint: `/health` if available
   - External: Yes
2. Run health check from admin UI
3. Register ChatGPT connection to Caddington MCP in AI Clients registry
4. Wire usage reporting: Caddington MCP (or gateway) POSTs usage events to:
   ```
   POST https://api.infra.example.com/api/usage-events
   ```
5. Simulate/debit credits on Caddington tenant

This proves: **AI client → MCP → INFRA metering → billing** before adding EL BigChange.

---

## 13. Company portal & auth (next phase)

After API + admin are live:

1. **Cloudflare Access** or magic-link auth for platform admin
2. Company portal login scoped to `company_id`
3. Charlie (EL Owner) sees only EL; HT owner sees only HT
4. Role assignment: engineer, office_staff, manager, etc. (presets in `role-presets.ts`)

---

## 14. Cursor knowledge bridge (next phase)

See `infra/docs/CURSOR-BRIDGE.md`.

**v0.1 manual path:**
- MCP/API error occurs → logged in INFRA audit
- You fix in Cursor → POST definition/runbook to INFRA API
- Knowledge available to ChatGPT on next request

**v0.2 automated path:**
- INFRA POSTs escalation to Cursor webhook
- Cursor agent responds with API guidance
- Approval → glossary/runbook stored

---

## 15. Ongoing operations

| Task | How |
| --- | --- |
| Deploy API change | `git push` → CI or manual `wrangler deploy` |
| Deploy UI change | Push to Git → Pages auto-build |
| Add connector (v0.1) | Cursor builds MCP tools → register in INFRA admin |
| Monitor health | Admin → System Health; MCP health cron |
| Top-ups | Company portal → Stripe test/live |
| View usage | Company portal → Usage / Billing |

**Automations (8am quotes etc.):** Built in Cursor as Workers + Cron; registered in INFRA with service identity + permissions.

---

## 16. Troubleshooting

| Problem | Likely cause | Fix |
| --- | --- | --- |
| `localhost:5173` connection refused on your PC | Dev server not running locally | `cd infra && npm run dev:web` |
| API 404 on custom domain | Route not attached | Workers → Domains & Routes |
| D1 empty in production | Migrations not applied remote | `wrangler d1 migrations apply ... --remote` |
| Stripe webhook fails | Wrong secret or URL | Check `whsec_` and endpoint URL |
| CORS errors | API CORS config | Worker CORS allows Pages origin |
| Cross-company data visible | Missing `company_id` filter | Bug — fix before go-live |

---

## 17. Phase checklist summary

### Phase 1 — Infrastructure (you are here)
- [ ] Cloudflare account + domain on Cloudflare DNS
- [ ] D1 database created + migrations applied
- [ ] API deployed to `api.infra.example.com`
- [ ] Admin UI deployed to `admin.infra.example.com`
- [ ] Health check passes

### Phase 2 — First live loop
- [ ] Caddington MCP registered + health monitoring
- [ ] ChatGPT connected to Caddington MCP (document in AI Clients)
- [ ] Usage events POST to INFRA
- [ ] Simulated billing debits Caddington credits

### Phase 3 — Stripe & company portal
- [ ] Stripe test webhooks working
- [ ] Company portal at `app.infra.example.com`
- [ ] Auth: Charlie logs into EL portal only
- [ ] Role presets assigned to users

### Phase 4 — EL / HT connectors (developer-led v0.1)
- [ ] BigChange connector for EL (explicit approval before live creds)
- [ ] Commusoft connector for HT
- [ ] Dashboard updates when connected
- [ ] Read/write permissions enforced per role

### Phase 5 — Cursor bridge & definitions
- [ ] Company definitions store live
- [ ] Cursor escalation API (manual then automated)
- [ ] Glossary + revenue rules per company

### Phase 6 — Self-service (v0.2)
- [ ] “Connect now” for connectors
- [ ] Owner approval of definitions in portal
- [ ] WhatsApp gateway design

---

## Quick reference — commands

```bash
# Clone / open repo
git clone https://github.com/daniel00123-tech/Main.git
cd Main/infra

# Install
npm install

# Local dev
npm run db:migrate:local
npm run db:seed:local
npm run dev          # API :8787
npm run dev:web      # UI  :5173

# Production deploy
cd packages/api && wrangler deploy
cd ../web && npm run build && wrangler pages deploy dist --project-name=infra-web

# Remote D1
wrangler d1 migrations apply infra-control-plane --remote
```

---

## Related documents

| Document | Contents |
| --- | --- |
| `infra/docs/DESIGN.md` | Full architecture, schema, permissions, billing |
| `infra/docs/CURSOR-BRIDGE.md` | Cursor ↔ INFRA query escalation |
| `infra/README.md` | Monorepo overview and local dev |

---

## Support path with ChatGPT

To use this guide interactively in ChatGPT:

1. Download or copy this entire file
2. Prompt: *“I am deploying INFRA using the attached SETUP-GUIDE.md. Walk me through Phase 1 step by step. Ask me to confirm each step before continuing.”*
3. Provide outputs (e.g. D1 database ID, errors) back to ChatGPT as you go

---

*Document version: v0.1 — aligned with INFRA design branch `cursor/infra-platform-v0-1-d3d8`*
