# INFRA

**Administration and control platform for business AI infrastructure.**

INFRA is the control plane behind staff-facing AI interfaces such as ChatGPT and Claude. It does not replace those interfaces. Instead, it manages companies, MCP environments, connectors, credentials, permissions, usage, billing, monitoring, and sync status.

Business systems remain the systems of record. Customer data stays isolated per company.

> **Authoritative boundary (ADR 001):**  
> Company MCPs own company knowledge, business data and business capabilities.  
> INFRA owns identity, authorisation, routing, metering, billing and audit.  
> AI clients connect to INFRA — not directly to company MCPs or business systems.  
> See [`docs/adr/001-company-mcp-vs-infra-boundary.md`](docs/adr/001-company-mcp-vs-infra-boundary.md).

## What INFRA manages (v0.1)

- Companies and demo tenants
- MCP environment registration and health monitoring
- Connector catalogue and per-company connector instances
- Credential references (not customer data)
- Permissions model (schema)
- Usage and prepaid credit balances (schema)
- Audit events and sync history
- Admin dashboard for control plane visibility

## What INFRA does not do in v0.1

- Staff-facing chat UI
- Full knowledge engine (Caddington MCP remains external)
- Structured data warehouse
- Automation/workflow builder
- WhatsApp gateway
- Live connections for HT Business or EL Business
- Personal Gmail/Outlook connectors

## Architecture

```
Business systems (BigChange, Commusoft, Xero, Google Drive, etc.)
        ↓
Company Business MCP / data environment
  (knowledge · warehouse · connectors · read/write tools)
        ↓
INFRA control plane / AI gateway
  (identity · authz · routing · metering · billing · audit)
        ↓
ChatGPT / Claude / future AI clients
```

### Control plane vs company Business MCP

| INFRA (control plane) | Company Business MCP / data environment |
| --- | --- |
| Companies, users, roles | Documents and vectors |
| MCP registrations & routing | CRM / job / operational data |
| Connector *registry* & status | Live business-system connectors & sync |
| Permissions & approvals | Indexed knowledge + warehouse |
| Health metadata, usage, billing, audit | Company-specific business logic & tools |

Do **not** move company operational corpora into INFRA’s control-plane database.

## Demo tenants

| Company | Purpose |
| --- | --- |
| Caddington Holdings | Reference tenant with external Caddington MCP registered |
| HT Business | Placeholder for future Commusoft connector |
| EL Business | Placeholder for future BigChange connector |

## Monorepo layout

```
infra/
  migrations/              # D1 control plane schema
  packages/
    shared/                # Types + connector catalogue
    api/                   # Cloudflare Worker control plane API
    web/                   # Admin dashboard (React)
```

## Local development

Prerequisites: Node.js 20+

```bash
cd infra
npm install
npm run db:migrate:local
npm run db:seed:local
npm run dev          # API on http://localhost:8787
npm run dev:web      # Dashboard on http://localhost:5173
```

API endpoints include:

- `GET /api/summary`
- `GET /api/companies`
- `GET /api/companies/:slug/overview`
- `GET /api/connectors/catalogue`
- `GET /api/mcp-environments`
- `POST /api/mcp-environments/:id/health-check`

## Connector catalogue

Reusable connector definitions are declared in `packages/shared/src/connectors/catalogue.ts`.

Planned connectors:

- Google Drive / Workspace shared storage
- Microsoft SharePoint
- Microsoft OneDrive (shared)
- Outlook shared mailboxes
- BigChange
- Commusoft
- Xero
- Freshdesk
- Custom API

Each connector declares capabilities such as `read`, `search`, `write`, `sync`, `webhook`, `index`, `export`, and `live_query`.

## Caddington MCP

The existing Caddington MCP is registered as an external MCP environment and is not migrated in v0.1. INFRA monitors and registers it only.

## Related documents

| Document | Contents |
| --- | --- |
| [`docs/DESIGN.md`](docs/DESIGN.md) | Full architecture, schema, permissions, billing |
| [`docs/SETUP-GUIDE.md`](docs/SETUP-GUIDE.md) | **Go-live guide** — hosting, domain, Cloudflare, Stripe, phases |
| [`docs/CURSOR-BRIDGE.md`](docs/CURSOR-BRIDGE.md) | Cursor ↔ INFRA knowledge escalation |
| [`deployment-pack/`](deployment-pack/) | **Full deployment pack** (zip-ready docs for ChatGPT) |

## Deployment

The API is designed for Cloudflare Workers + D1. Update `packages/api/wrangler.toml` with production D1 database IDs before deploying:

```bash
cd infra/packages/api
npm run deploy
```

## Roadmap (post v0.1)

- Live connector runtime and credential vault integration
- Per-company data environment provisioning
- Stripe billing integration
- Structured warehouse sync framework
- WhatsApp / Teams gateway interfaces
- Automation visibility (not builder)
