# INFRA

**Administration and control platform for business AI infrastructure.**

INFRA is the control plane behind staff-facing AI interfaces such as ChatGPT and Claude. It does not replace those interfaces. Instead, it manages companies, MCP environments, connectors, credentials, permissions, usage, billing, monitoring, and sync status.

Business systems remain the systems of record. Customer data stays isolated per company.

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
INFRA connector instance (per company)
        ↓
Company data environment (isolated)
        ↓
Company MCP environment
        ↓
ChatGPT / Claude / future channels
```

### Control plane vs customer data plane

| Control plane (INFRA central) | Customer data plane (per company) |
| --- | --- |
| Companies | Documents and vectors |
| MCP registrations | CRM / job data |
| Connector definitions & instances | API credentials (secrets store) |
| Permissions | Operational warehouse data |
| Health, usage, billing | Indexed knowledge content |

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
