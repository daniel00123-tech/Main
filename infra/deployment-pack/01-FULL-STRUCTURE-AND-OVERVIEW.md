# INFRA — Full Structure & System Overview

> **Authoritative boundary:** [ADR 001 — Company MCP vs INFRA](../docs/adr/001-company-mcp-vs-infra-boundary.md).  
> Company MCPs own knowledge/data/capabilities; INFRA owns identity/authz/routing/metering/billing/audit; AI clients connect to INFRA.

## Two interfaces, one backend

```
┌─────────────────────────────────────────────────────────────┐
│  PLATFORM ADMIN (you)                                       │
│  admin.infra.yourdomain.com                                 │
│  • All companies (Caddington, HT, EL)                       │
│  • All MCP environments                                     │
│  • System health, audit, billing overview                   │
│  • Developer connector setup                                │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│  INFRA CONTROL PLANE (Cloudflare Workers + D1)              │
│  api.infra.yourdomain.com                                   │
│  • Companies, users, roles                                  │
│  • MCP registry, connector instances                        │
│  • Permissions (read/write per role)                        │
│  • Usage metering, prepaid credits, Stripe                  │
│  • Company definitions (revenue rules, glossary)            │
│  • Cursor knowledge bridge                                  │
│  • Audit log                                                │
└───────────────────────────┬─────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│ COMPANY       │   │ COMPANY       │   │ COMPANY       │
│ PORTAL        │   │ PORTAL        │   │ PORTAL        │
│ Caddington    │   │ HT Business   │   │ EL Business   │
│ app.infra…    │   │ app.infra…    │   │ app.infra…    │
│ (own co only) │   │ (own co only) │   │ (own co only) │
└───────────────┘   └───────────────┘   └───────────────┘
        │                   │                   │
        ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│ CUSTOMER      │   │ CUSTOMER      │   │ CUSTOMER      │
│ DATA PLANE    │   │ DATA PLANE    │   │ DATA PLANE    │
│ MCP + R2 +    │   │ MCP (future)  │   │ MCP (future)  │
│ D1 + Vectorize │   │ Commusoft     │   │ BigChange     │
└───────────────┘   └───────────────┘   └───────────────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            ▼
              ChatGPT · Claude · WhatsApp (future)
```

---

## Request flow (staff using ChatGPT)

```
John (Engineer @ EL) asks ChatGPT:
"When is engineer 7 booked?"
        ↓
ChatGPT → EL MCP tool (read schedule)
        ↓
INFRA: permission check (engineer role ✓) + meter (£0.05)
        ↓
BigChange API → answer
        ↓
ChatGPT → John

Sarah (Office Staff) asks:
"Book engineer 7 tomorrow 9am"
        ↓
INFRA: permission check (office_staff ✓) + meter (£0.80)
        ↓
BigChange write → done

John (Engineer) asks same booking:
        ↓
INFRA: permission DENIED → no charge → ChatGPT explains
```

---

## Automation flow (Cursor-built, e.g. 8am quotes)

```
Cloudflare Cron 08:00
        ↓
HT Automation Worker (built in Cursor)
        ↓
INFRA: service identity permission + credits
        ↓
HT MCP → Commusoft (send quotes)
        ↓
INFRA: meter batch send + audit
        ↓
HT portal shows "Automation completed"
```

---

## Cursor knowledge bridge (when AI is stuck)

```
ChatGPT/MCP hits unknown API error
        ↓
INFRA escalates to Cursor (developer knowledge)
        ↓
Cursor responds with fix / runbook
        ↓
Approved → stored as glossary/runbook
        ↓
Next request: cached — no Cursor needed
```

---

## Company roles (preset)

| Role | Read | Write |
| --- | --- | --- |
| Engineer | Own jobs, schedule | Notes only |
| Junior Office | Customers, jobs | Notes only |
| Office Staff | All jobs | Book jobs, POs |
| Supervisor | Team data | Invoices (limited) |
| Manager | Full read | Jobs, POs, invoices, quotes |
| Director | Full | Broad write |
| Company Admin | All + admin | Users, connectors |

---

## What is NOT in v0.1

- WhatsApp gateway (designed, not built)
- Self-service "Connect now" connectors (v0.2)
- Structured data warehouse
- Automation builder UI in INFRA
- Live EL/HT connectors until explicitly approved

---

## Cloudflare resource map

| INFRA component | Cloudflare service |
| --- | --- |
| Control plane API | Workers |
| Control plane DB | D1 |
| Admin UI | Pages |
| Company portal UI | Pages |
| Connector credentials | Workers Secrets |
| Customer documents | R2 (per company) |
| Vector search | Vectorize (per company) |
| Async jobs / webhooks | Queues |
| Health checks / cron | Cron Triggers |
| Stripe webhooks | Worker route |

---

## Demo companies (seed data)

| Company | Primary future connector | v0.1 status |
| --- | --- | --- |
| Caddington Holdings | Google Drive (external MCP) | Registered, monitored |
| HT Business | Commusoft | Draft, not connected |
| EL Business | BigChange | Draft, not connected |

---

See **`02-SETUP-GUIDE.md`** for step-by-step deployment.
