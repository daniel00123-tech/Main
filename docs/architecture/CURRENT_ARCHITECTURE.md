# Current INFRA architecture

This describes **what the code and Wrangler config implement today** on the consolidation branch (WhatsApp V4.2 tip + Cloud Agent environment). It is not a roadmap.

For status of each capability see [../CAPABILITY_MATRIX.md](../CAPABILITY_MATRIX.md).
For “do not rebuild this” see [../PROJECT_STATUS.md](../PROJECT_STATUS.md).

## System context

INFRA is a Cloudflare-first control plane:

- **Worker `infra-api`** — identity, authz, MCP gateway, connectors, billing, automations, WhatsApp, OCR orchestration, quality loop
- **Pages `infra-web`** — admin control panel + reusable company portal at `app.infrastack.app`
- **Company Business MCPs** — per-tenant knowledge/tools. Caddington / HT / EL Workers are registered; only Caddington has a snapshot/inject pipeline in this repo
- **D1 `infra-control-plane`** — control-plane data only (not customer document bytes)
- Customer knowledge bytes live in the company MCP (Caddington: D1 + R2 + Vectorize)

Cursor is **not** on any production request path.

## Canonical request paths

### Standard MCP

```
AI client (ChatGPT / Claude)
  → https://mcp.infrastack.app/api/gateway/v1/mcp
  → infra-api MCP gateway (service token or session)
  → permission + wallet + audit + interaction grouping
  → company Business MCP via Workers service binding
       (fallback: public endpoint URL + auth secret)
  → tools/list and tools/call
```

Facade extras on the gateway (not copied into the company MCP):

- Standard `search` / `fetch` adaptors → `search_company_knowledge` / `get_knowledge_document`
- Xero **read** tools (executed on INFRA or forwarded)
- Outlook read tools
- Action-control and automation-control tools
- Xero **write** tool names are filtered from `tools/list`; writes use the Action Engine

ChatGPT stores a frozen tool snapshot. After catalogue changes, the Workspace app must be refreshed/republished.

### WhatsApp

```
User device
  → Meta WhatsApp Cloud API
  → GET/POST https://api.infrastack.app/api/webhooks/whatsapp
  → signature check + persist inbound event (fail-open persist)
  → greeting/thanks fast-lane (optional immediate reply)
  → enqueue WHATSAPP_INBOUND_QUEUE (+ 10s/30s watchdog messages)
  → queue consumer: identity (E.164 → user → memberships → permissions)
  → conversational brain (plan, entity memory, tools via gateway)
  → Meta send (text / buttons / list) + quality telemetry
```

Authoritative write-up: [../channels/WHATSAPP.md](../channels/WHATSAPP.md).

### Knowledge

```
Source (Google Drive on company MCP, or Microsoft Graph on infra-api)
  → extract text; Azure Document Intelligence if requires_ocr
  → chunk + embed + index on the company MCP (Caddington: Vectorize + R2)
  → retrieval only through the authenticated company MCP / INFRA gateway
```

INFRA does not store customer document bodies in control-plane D1.

### Automation

```
Cron */15 (scheduler) or portal/MCP “Run now”
  → Automation Engine (dedup, plan, permissions)
  → AUTOMATION_RUN_QUEUE (self-fetch fallback if unbound)
  → handler (Xero sales email, document activity email, MCP tool, AI prompt, internal)
  → outbox / MCP / audit
```

Shipped templates: daily Xero MTD sales email; daily document activity email.

### Continuous Quality Loop

```
WhatsApp interactions + audit signals
  → cadence: daily 08:00 Europe/London for 60 days, then Friday weekly
  → evaluator (quality-loop-whatsapp-v1)
  → patterns → proposals
  → admin review / approve (email token + admin UI)
  → replay / UAT validation
  → canary runtime → promote or rollback
```

High-risk / engineering proposals are **report-only** and never auto-applied.
Authoritative write-up: [../quality/CONTINUOUS_QUALITY_LOOP.md](../quality/CONTINUOUS_QUALITY_LOOP.md).

## Control plane vs data plane

| Control plane (`infra-api` + D1) | Company data plane (Business MCP) |
| --- | --- |
| Companies, users, memberships, roles | Documents, chunks, vectors |
| Connector **instances** and encrypted credential envelopes | Live business APIs (Xero, Graph, Drive) |
| Wallet, usage, interactions, economics | Knowledge index |
| Action plans, automations, quality config | Company-specific tools |
| WhatsApp identity map and inbound events | — |

## Tenants (configuration, not three apps)

| Company | ID | Slug | Business MCP |
| --- | --- | --- | --- |
| Caddington Holdings | `co_caddington` | `caddington-holdings` | `caddington-mcp` (reference) |
| HT Business | `co_ht` | `ht-business` | `ht-business-mcp` (registered, paused) |
| EL Business | `co_el` | `el-business` | `el-business-mcp` (registered, paused) |

A fourth company is created from Platform Admin (`POST /api/companies`) without new React routes. Business MCP is **not** auto-provisioned.

## Portals

One React app (`@infra/web`):

- **Admin** — `/` after platform-admin login (companies, MCP, economics, interactions, quality, billing)
- **Company portal** — `/portal/:companySlug/…` (also legacy `*.infra-web.pages.dev` subdomains)
- **Public** — `/privacy`, login, password setup

Session cookie: `infra_session` (HS256 JWT, 12h). Host-only on `app.infrastack.app`.

## Runtime topology

```
                    ┌─ Cloudflare Email (noreply@infrastack.app)
                    ├─ Workers AI (Whisper STT)
                    ├─ Azure Document Intelligence (OCR)
                    ├─ Meta Cloud API (WhatsApp)
                    ├─ Xero / Microsoft Graph / Stripe
app.infrastack.app ─┤
mcp.infrastack.app ─┼─ infra-api Worker
api.infrastack.app ─┤    D1 infra-control-plane
                    │    queues: whatsapp-inbound, automation-runs,
                    │            microsoft-knowledge-ingest (+ DLQs)
                    │    service bindings → caddington-mcp, ht-business-mcp,
                    │                       el-business-mcp
                    └─ cron: 0 */6 (Microsoft sync), */15 (automations,
                       WhatsApp reaper, quality-loop cadence)
```

## What is not deployed (do not describe as live)

- Automated per-tenant MCP Worker provisioning (ADR 011 / 030 warehouse)
- BigChange / Commusoft / GoHighLevel / Freshdesk / custom-api runtimes
- Quality loop evaluators for ChatGPT / Claude / portal (types exist; runner is WhatsApp-only)
- Inbound product email / monitored aliases (`support@`, `billing@`, `admin@` reserved only)

## Key source files

| Area | Path |
| --- | --- |
| Worker entry | `infra/packages/api/src/index.ts` |
| Wrangler | `infra/packages/api/wrangler.toml` |
| MCP gateway | `infra/packages/api/src/services/mcp-gateway.ts` |
| WhatsApp webhook | `infra/packages/api/src/routes/whatsapp.ts` |
| WhatsApp brain | `infra/packages/api/src/services/whatsapp-orchestrator.ts` |
| Quality loop | `infra/packages/api/src/services/quality-loop/` |
| Canonical URLs | `infra/packages/shared/src/platform/urls.ts` |
| Connector catalogue | `infra/packages/shared/src/connectors/catalogue.ts` |
