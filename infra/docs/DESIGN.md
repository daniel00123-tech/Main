# INFRA — Architecture & Design (v0.1)

This document fulfils the design-first requirement before substantial implementation. It describes architecture, data models, security boundaries, and a phased delivery plan. No external systems are connected.

---

## 1. Environment inspection

The repository currently contains:

- **Legacy automation scripts** (`scripts/`, `tests/`) — unrelated BigChange/Freshdesk automations. These remain untouched.
- **INFRA scaffold** (`infra/`) — new monorepo added on branch `cursor/infra-platform-v0-1-d3d8`:
  - `packages/api` — Cloudflare Worker control-plane API (Hono + D1)
  - `packages/web` — React admin dashboard (prototype shell)
  - `packages/shared` — shared types and connector catalogue
  - `migrations/` — D1 control-plane schema

INFRA is intentionally isolated under `infra/` as a greenfield project. No connection to legacy Nirvana, Aquilo, or Urban Maintenance systems.

---

## 2. Architecture overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         INFRA CONTROL PLANE                             │
│  (Cloudflare Workers API + D1 + Secrets + Stripe webhooks)            │
│                                                                         │
│  Companies · MCP Registry · Connectors · Permissions · Billing        │
│  Usage Metering · Audit · Health · AI Client Registry                   │
│  Company Definitions (rules, glossary, correction workflow)             │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ registers / monitors / bills
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
┌───────────────┐     ┌───────────────┐     ┌───────────────┐
│ Caddington    │     │ HT Business   │     │ EL Business   │
│ data plane    │     │ data plane    │     │ data plane    │
│ (external MCP)│     │ (future)      │     │ (future)      │
└───────┬───────┘     └───────────────┘     └───────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────────────────┐
│  Customer data plane (per company, isolated)                          │
│  R2 · D1 · Vectorize · connector sync state · warehouse (future)      │
└───────────────────────────────┬───────────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
   ChatGPT                  Claude                 WhatsApp (future)
```

**Principle:** Business systems remain systems of record. INFRA orchestrates connectors, permissions, billing, and monitoring — it does not replace staff-facing AI clients.

---

## 3. Repository structure

```
infra/
  docs/
    DESIGN.md                 # This document
  migrations/                 # D1 control-plane migrations
  packages/
    shared/                   # Types, connector catalogue, capability/risk model
    api/                      # Control-plane Worker API
    web/                      # Admin UI (Cloudflare Pages)
  package.json                # npm workspaces root
```

Future packages (post-approval):

```
packages/
  billing/                    # Ledger, pricing engine, Stripe handlers
  connectors-runtime/         # Connector worker runtime (per sync job)
  definitions/                # Company definitions service + MCP injection helpers
```

---

## 4. Cloudflare resources

| Resource | Purpose |
| --- | --- |
| **Workers** | Control-plane API, Stripe webhooks, health-check cron, future connector sync workers |
| **D1** | Control-plane database (companies, registry, ledger, audit) |
| **Pages** | Admin web application |
| **R2** | Per-company customer data storage (not in control plane) |
| **Vectorize** | Per-company vector indexes (customer data plane) |
| **Queues** | Async usage events, sync jobs, webhook processing |
| **Cron Triggers** | MCP health checks, connector sync schedules |
| **Workers Secrets** | Stripe keys, platform secrets |
| **Secrets Store / per-company secrets** | Connector credentials (references in D1 only) |

**Tenant isolation:** Each company receives isolated customer-plane resources (separate R2 prefixes, D1 databases or namespaces, Vectorize indexes). The control plane stores only metadata and foreign keys (`data_plane_id`, `data_environment_id`).

---

## 5. D1 schema (control plane)

### Existing (migration 0001)

- `companies`
- `mcp_environments`
- `connector_instances`
- `credential_refs` (metadata only — no plaintext secrets)
- `permission_grants`
- `credit_balances`
- `usage_records` (basic)
- `audit_events`
- `sync_history`

### Planned (migration 0002+)

```sql
-- AI client registry
ai_clients (id, company_id, client_type, display_name, status, mcp_environment_id, ...)

-- Users & roles
users (id, email, name, platform_role, ...)
company_users (company_id, user_id, role, ...)
roles (id, company_id, name, permissions_json)

-- Immutable billing ledger
ledger_entries (
  id, company_id, entry_type,  -- CREDIT | DEBIT
  amount_cents, currency,
  source_event_id, request_id,  -- idempotency
  service, operation,
  actual_cost_cents, customer_charge_cents, margin_cents,
  pricing_rule_version, metadata_json, status,
  created_at  -- append-only, no UPDATE
)

-- Pricing
pricing_rules (id, version, service, operation, rule_type, config_json, effective_from)

-- Stripe
stripe_customers (company_id, stripe_customer_id)
stripe_events (event_id, type, processed_at, payload_hash)  -- idempotent webhook dedup

-- MCP registry extensions
ALTER mcp_environments ADD health_endpoint_url, auth_secret_ref, version, capabilities_json, enabled

-- Errors / health
system_errors (id, company_id, source_type, source_id, severity, message, created_at)

-- Company definitions (see Section 22)
company_definitions (...)
glossary_entries (...)
definition_correction_proposals (...)
definition_versions (...)
```

Customer documents, vectors, CRM records, and API credentials **never** live in the control-plane D1.

See **Section 22** for the full company definitions schema.

---

## 6. Tenant isolation

| Layer | Isolation mechanism |
| --- | --- |
| Control plane | Single D1; all rows scoped by `company_id`; platform-owner role for cross-tenant admin |
| Credentials | Per-company secret bindings in Workers Secrets or dedicated secret store; D1 holds `secret_ref` only |
| Knowledge / vectors | Per-company Vectorize index + R2 prefix |
| Structured warehouse | Per-company D1 or dedicated DB (future) |
| MCP environments | One or more per company; endpoint + auth scoped to company |
| Billing | Ledger entries always include `company_id`; balances computed per company |

**Rule:** No shared customer knowledge database. No cross-company queries without Platform Owner authorization.

---

## 7. Authentication

**v0.1 approach:**

- Platform admin login via **Cloudflare Access** or email magic-link / OAuth (e.g. Google Workspace for operators only)
- Session JWT issued by control-plane Worker; HttpOnly cookie
- API routes enforce `platform_role` (Platform Owner) or `company_role` (Administrator, etc.)
- Service-to-service: API keys for connector workers and MCP health cron

**Not in v0.1:** Self-service customer onboarding, SSO for end users (staff use ChatGPT/Claude directly).

---

## 8. Secret management

```
Browser → API (credential metadata only)
API → Secret Store (write credential, returns secret_ref)
D1 → stores secret_ref, label, provider, status, expires_at
Connector Worker → reads secret via secret_ref at runtime
```

**Rules:**

- Never store plaintext credentials in D1
- Never return secrets to browser after initial write
- Never log secrets
- Support rotation: new secret_ref, deprecate old, update `credential_refs.status`
- Track `last_successful_auth_at`, `expires_at`, `revoked_at`

---

## 9. Connector catalogue

Reusable connector **definitions** (code + metadata) in `packages/shared`:

| Connector | Category | v0.1 status |
| --- | --- | --- |
| Google Drive / Workspace | cloud_storage | Framework + Caddington instance (external) |
| SharePoint | cloud_storage | Catalogue only |
| OneDrive (shared) | cloud_storage | Catalogue only |
| Outlook shared mailbox | email | Catalogue only |
| BigChange | field_service | Catalogue only (EL placeholder) |
| Commusoft | field_service | Catalogue only (HT placeholder) |
| Xero | accounting | Catalogue only |
| Freshdesk | helpdesk | Catalogue only |
| Custom API | api | Catalogue only |

**Not included:** Personal Gmail, personal Outlook, personal calendar.

---

## 10. Connector instances

Each instance binds:

- `company_id`
- `connector_definition_id`
- `name`, `config`, `sync_settings`
- `credential_refs[]` (isolated per company)
- `permission_grants[]`
- `data_environment_id` (customer plane)
- `status`, `health_status`, sync history

Example: `conn_bigchange` implementation → `ci_el_bigchange` instance (draft, not connected).

---

## 11. MCP registrations

Registry fields:

| Field | Example (Caddington) |
| --- | --- |
| company | Caddington Holdings |
| display name | Caddington MCP |
| endpoint | `https://caddington-mcp.example/mcp` |
| health endpoint | `https://caddington-mcp.example/health` |
| transport | SSE |
| auth secret ref | `sec_caddington_mcp_auth` |
| version | `1.0.0` (reported) |
| status | registered / healthy / degraded / unreachable |
| enabled | true |
| is_external | true |
| data_plane_id | `dp_caddington_knowledge` |
| capabilities | knowledge_search, hybrid_search, document_list |
| last health check | timestamp |

**v0.1:** Register and monitor Caddington MCP. Do not modify or migrate it.

---

## 12. Capability & permission structure

### Connector capabilities

`READ` · `SEARCH` · `ANALYSE` · `CREATE` · `UPDATE` · `DELETE` · `SEND` · `BATCH` · `WEBHOOK` · `SYNC`

### Risk classes

`LOW_RISK` · `WRITE` · `DELETE` · `BATCH_WRITE` · `EXTERNAL_SEND` · `FINANCIAL_ACTION` · `HIGH_RISK`

Each capability maps to a default risk class. Permissions grant capabilities per role; high-risk actions can later require approval (not built in v0.1, but schema supports it).

### Roles (foundation)

INFRA uses **two role layers**:

1. **Platform roles** — INFRA administration (Platform Owner, etc.)
2. **Company roles** — preset bundles for field-service staff (Engineer → Director)

Company roles are defined in `packages/shared/src/permissions/role-presets.ts` and enforced **server-side** on every MCP tool call, regardless of channel (ChatGPT, Claude, WhatsApp, Cursor automation).

#### Company role presets

| Role | Read examples | Write examples | Blocked by default |
| --- | --- | --- | --- |
| **Engineer** | Own schedule, assigned jobs, knowledge search | Add job notes | Book jobs, POs, invoices |
| **Junior Office** | Customers, jobs, engineer schedules | Add notes | Book jobs, POs, invoices |
| **Office Staff** | All jobs, customers, schedules | Book engineer, create job, raise PO | Create invoices |
| **Supervisor** | Team jobs, customers, financials (read) | Book engineer, create invoice | Delete, batch |
| **Manager** | Full operational read | Jobs, POs, invoices, send quotes | Delete, batch |
| **Director** | Full read | Full operational + financial write | Delete (may need approval) |
| **Company Admin** | All + admin | User/connector management scope | Platform-level actions |

Companies can override presets per role in v0.2+. v0.1 uses these defaults.

#### Platform roles

| Role | Typical permissions |
| --- | --- |
| Platform Owner | INFRA admin, billing, company setup |
| Site Administrator | Company-wide admin |
| Administrator | Connector config, user management |

Permissions enforced **server-side** on MCP tool invocation and connector operations.

See **Section 23** for read/write command flows and worked examples.

---

## 13. Usage metering

Usage events are **idempotent** (keyed by `request_id`).

```typescript
interface UsageEvent {
  id: string;
  companyId: string;
  userId?: string;
  requestId: string;        // idempotency key
  timestamp: string;
  provider: string;         // openai, cloudflare, bigchange, ...
  mcpEnvironmentId?: string;
  connectorInstanceId?: string;
  toolOrAction: string;
  operation: string;
  aiModel?: string;         // not hard-coded to specific models long-term
  tokenUsage?: number;
  infrastructureCostCents: number;
  externalApiCostCents: number;
  customerChargeCents: number;
  status: 'completed' | 'failed' | 'reversed';
}
```

Retries must not double-bill. Failed operations may still incur cost (recorded separately).

---

## 14. Immutable billing ledger

Append-only `ledger_entries`. No edits to historical rows.

**CREDIT sources:** Stripe top-up, promotional credit, manual adjustment, refund/reversal

**DEBIT sources:** AI processing, connector/API usage, MCP usage, document processing, warehouse processing (future)

Each entry stores: `actual_cost_cents`, `customer_charge_cents`, `margin_cents`, `pricing_rule_version`, `source_event_id`, `request_id`, `metadata`.

**Corrections:** Compensating entries only (e.g. refund CREDIT for erroneous DEBIT).

---

## 15. Credit calculation

```
customer_balance = SUM(credits) - SUM(debits)   -- from ledger, not mutable balance field
```

`credit_balances` table is a **cached snapshot** updated transactionally when ledger entries are appended. Source of truth is the ledger.

---

## 16. Pricing rules & versioning

```
customer_charge = MAX(minimum_charge, actual_cost * (1 + markup_pct)) + fixed_fee
```

`pricing_rules` table:

- `version` — immutable once published
- `service`, `operation` — e.g. `knowledge_search`, `document_processing`
- `rule_type` — fixed, percentage, minimum, customer_override
- `config_json` — rates, minimums, customer-specific overrides

Usage records and ledger entries always reference `pricing_rule_version` active at event time.

---

## 17. Stripe (test mode)

**Flow:**

1. Admin initiates top-up → API creates Stripe Checkout Session / PaymentIntent
2. Customer pays on Stripe-hosted page (card data never touches INFRA)
3. Stripe webhook → Worker verifies signature + idempotency (`stripe_events`)
4. On `payment_intent.succeeded` → append CREDIT ledger entry
5. Update cached `credit_balances`

**Never credit on browser success alone.**

v0.1: Test mode only. No automatic top-up.

---

## 18. Audit logging

Log observable admin/system actions:

- Actor (user or `infra-system`)
- Company, timestamp, request ID
- Resource type/ID, action, result/status, error

**Do not store:** model chain-of-thought, raw secrets, card data.

---

## 19. Caddington MCP registration (no modification)

Caddington Holdings is seeded with:

- External MCP environment (`is_external = true`)
- Google Drive connector instance (managed by external MCP)
- Simulated usage/billing data (control plane only — no changes to Caddington MCP)

---

## 20. Risks & weaknesses

| Risk | Mitigation |
| --- | --- |
| Cross-tenant data leak | Strict `company_id` scoping; separate customer-plane resources |
| Secret exposure | Secret refs only in D1; Workers Secrets at runtime |
| Double billing | Idempotent `request_id` on usage + ledger; Stripe event dedup |
| Legacy credential reuse | Explicit approval workflow before any external connection |
| Over-scoping v0.1 | Phased delivery; prototype approval before Stripe/auth |
| Control plane as bottleneck | Queues for async metering and sync |
| MCP health false positives | Dedicated health endpoint + latency thresholds |

---

## 21. Phased development plan

### Stage 0 — Design & prototype (current)
- [x] Architecture design (this document)
- [ ] Visual prototype with all admin pages (mock data)
- [ ] User approval of layout/UX

### Stage 1 — Admin shell
- Full navigation, auth, company registry, settings

### Stage 2 — Registry & health
- Connector catalogue UI, MCP registry (full fields), health cron, AI client registry

### Stage 3 — Usage & ledger
- Usage event ingestion, immutable ledger, pricing rules, Caddington simulated billing

### Stage 4 — Stripe test mode
- Checkout, webhooks, top-ups, transaction history

### Stage 5 — Caddington integration
- Register external MCP, health monitoring, simulated usage debits

### Stage 6 — Real connectors (one at a time)
- Only after platform shell proven; explicit approval per connection

### Stage 6 — Real connectors (one at a time)
- Only after platform shell proven; explicit approval per connection

### Stage 7 — Company definitions
- Definitions store, correction capture, approval workflow, MCP injection
- Cursor as primary authoring tool in v0.1; company portal approval in v0.2

---

## 22. Company definitions engine

This section describes how INFRA handles company-specific business language, calculation rules, and domain glossary — without building unconstrained AI self-learning or a separate organisational-memory product.

### 22.1 What it is (and is not)

| It **is** | It is **not** |
| --- | --- |
| A structured, approved rules store per company | Free-form AI memory that rewrites itself |
| Injected into MCP/AI context on every request | A separate ML training pipeline |
| Versioned, auditable, company-isolated | Shared knowledge across EL, HT, Caddington |
| Populated via corrections + approval | Silent learning from every chat message |

**Example:** EL Business defines `revenue = invoices - credit_notes`. HT Business defines `revenue = invoices + performers - credit_notes`. Same platform, different definitions, never mixed.

### 22.2 The engine — components

There is **no separate AI “learning engine.”** Company definitions are powered by:

```
┌─────────────────────────────────────────────────────────────────┐
│  1. DEFINITIONS STORE (INFRA control plane)                     │
│     Cloudflare D1 — structured rows, company-scoped             │
│     Tables: company_definitions, glossary_entries, proposals    │
└────────────────────────────┬────────────────────────────────────┘
                             │ read approved definitions
┌────────────────────────────▼────────────────────────────────────┐
│  2. DEFINITIONS SERVICE (Cloudflare Worker)                     │
│     packages/definitions — CRUD, approval, versioning, audit    │
│     API: GET /companies/:id/definitions (for MCP consumption) │
└────────────────────────────┬────────────────────────────────────┘
                             │ inject at request time
┌────────────────────────────▼────────────────────────────────────┐
│  3. MCP DEFINITION INJECTOR (company MCP layer)                 │
│     Loads definitions → adds to tool context / system prompt    │
│     BigChange tools apply revenue rule before returning data    │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  4. CORRECTION CAPTURE (INFRA gateway / MCP middleware)         │
│     User correction → proposal row → approval queue             │
│     Does NOT auto-promote to production without approval        │
└─────────────────────────────────────────────────────────────────┘
```

**Technology stack:** Cloudflare Workers + D1 + Queues (async proposal processing). No vector DB or ML model required for definitions themselves — they are structured data.

**Optional later:** semantic search over glossary via Vectorize for “did someone already define this term?” — not v0.1.

### 22.3 Three tiers of memory

| Tier | What | Storage | Persisted? |
| --- | --- | --- | --- |
| **1 — Conversation** | “I meant January, not February” | AI session context only | No |
| **2 — Company definitions** | “Revenue = invoices − credit notes” | INFRA D1 (`company_definitions`) | Yes, after approval |
| **3 — Source documents** | SOPs, policies, pricing in SharePoint/Drive | Customer data plane (R2, Vectorize) | Yes, synced from source |

Tier 2 is what this engine implements. Tier 3 is the existing Caddington knowledge approach. Tier 1 must never be silently promoted to Tier 2.

### 22.4 D1 schema (migration 0003 — planned)

```sql
-- Approved business rules and calculations
CREATE TABLE company_definitions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  slug TEXT NOT NULL,                    -- e.g. "revenue", "net_sales"
  display_name TEXT NOT NULL,            -- e.g. "Revenue"
  definition_type TEXT NOT NULL,         -- calculation | filter | mapping | behaviour
  connector_slug TEXT,                   -- e.g. "bigchange", null = global
  rule_expression TEXT NOT NULL,         -- e.g. "invoices - credit_notes"
  rule_config_json TEXT NOT NULL DEFAULT '{}',  -- structured rule for code execution
  description TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',  -- draft | pending | approved | deprecated
  risk_class TEXT NOT NULL DEFAULT 'low_risk',
  approved_by TEXT,
  approved_at TEXT,
  effective_from TEXT NOT NULL,
  effective_until TEXT,                  -- null = current
  source_proposal_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(company_id, slug, version)
);

CREATE INDEX idx_company_definitions_company ON company_definitions(company_id);
CREATE INDEX idx_company_definitions_active ON company_definitions(company_id, status);

-- Domain glossary (BigChange "parent contact", etc.)
CREATE TABLE glossary_entries (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  term TEXT NOT NULL,                    -- e.g. "parent contact"
  normalized_term TEXT NOT NULL,         -- lowercase for lookup
  system_slug TEXT,                      -- e.g. "bigchange"
  definition TEXT NOT NULL,
  api_hint_json TEXT NOT NULL DEFAULT '{}',  -- field names, filters, examples
  status TEXT NOT NULL DEFAULT 'draft',
  approved_by TEXT,
  approved_at TEXT,
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_glossary_company ON glossary_entries(company_id);
CREATE INDEX idx_glossary_term ON glossary_entries(company_id, normalized_term);

-- User corrections awaiting approval
CREATE TABLE definition_correction_proposals (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  proposal_type TEXT NOT NULL,           -- definition | glossary | filter
  source_channel TEXT NOT NULL,          -- chatgpt | claude | cursor | whatsapp | automation
  source_request_id TEXT,
  actor_user_id TEXT,
  actor_email TEXT,
  original_query TEXT,
  user_correction TEXT NOT NULL,
  proposed_slug TEXT,
  proposed_rule TEXT,
  proposed_config_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | merged
  reviewed_by TEXT,
  reviewed_at TEXT,
  resulting_definition_id TEXT,
  resulting_glossary_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_proposals_company ON definition_correction_proposals(company_id);
CREATE INDEX idx_proposals_status ON definition_correction_proposals(status);

-- Immutable history when definitions change
CREATE TABLE definition_versions (
  id TEXT PRIMARY KEY,
  definition_id TEXT NOT NULL REFERENCES company_definitions(id),
  company_id TEXT NOT NULL REFERENCES companies(id),
  version INTEGER NOT NULL,
  rule_expression TEXT NOT NULL,
  rule_config_json TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  change_reason TEXT,
  created_at TEXT NOT NULL
);
```

### 22.5 Where Cursor fits

Cursor is **not in the runtime path** for every staff ChatGPT message. Cursor is the **primary authoring and approval tool in v0.1**.

| Entry point | Who | What happens |
| --- | --- | --- |
| **Cursor (developer)** | You | Write/update definitions via INFRA API or synced config files; build MCP tools that consume them |
| **ChatGPT / Claude correction** | Staff | Correction captured → `definition_correction_proposals` → you approve in Cursor or admin UI |
| **Company portal (v0.2)** | Charlie (Owner) | Review pending proposals; approve glossary and low-risk rules |
| **Automation** | System | Reads approved definitions only — never writes new ones |

**v0.1 Cursor workflow:**

```
1. User corrects in ChatGPT: "Revenue means invoices minus credit notes"
2. INFRA logs proposal (pending)
3. You see proposal in admin UI or Cursor notification
4. In Cursor: review → POST /api/companies/el-business/definitions/approve
5. Definition active immediately for all MCP requests, automations, future WhatsApp
```

**Alternative v0.1 path (no live correction capture yet):**

```
You in Cursor: edit infra/definitions/el-business.yaml
        ↓
git commit → deploy → INFRA API syncs YAML → D1
        ↓
EL MCP loads on next request
```

Both paths write to the **same D1 store**. Cursor is the editor; INFRA is the engine.

### 22.6 Correction → approval → apply flow

```
User: "Find January 2026 invoices"
        ↓
MCP returns £100,000 (raw invoices — no revenue rule yet)
        ↓
User: "No — I meant sales: invoices minus credit notes"
        ↓
┌───────────────────────────────────────┐
│ INFRA: capture proposal               │
│   type: definition                    │
│   slug: revenue                       │
│   rule: invoices - credit_notes       │
│   status: pending                     │
│   source: chatgpt                     │
└───────────────────────────────────────┘
        ↓
Approval (v0.1: developer in Cursor / admin)
        ↓
┌───────────────────────────────────────┐
│ company_definitions row created       │
│   company_id: co_el                     │
│   slug: revenue                         │
│   rule: invoices - credit_notes         │
│   status: approved                      │
│   version: 1                            │
└───────────────────────────────────────┘
        ↓
Next request: MCP injector loads definition
        ↓
BigChange tool applies net calculation → £95,000
        ↓
Audit: definition.applied, request_id, result
```

**Auto-suggest (v0.2+):** After 3 similar corrections on the same term, INFRA suggests: “Create permanent definition for ‘revenue’?” — still requires approval.

**Never auto-approve:** `FINANCIAL_ACTION`, `BATCH_WRITE`, `DELETE`, calculation rules affecting billing/reporting — unless explicitly configured by Platform Owner.

### 22.7 MCP injection — how definitions reach the AI

On every MCP tool call, the company MCP:

1. Fetches approved definitions from INFRA API (cached 60s in MCP Worker)
2. Fetches glossary entries matching terms in the user query
3. Injects into tool execution context:

```typescript
// Pseudocode — MCP tool handler
const definitions = await infra.getDefinitions(companyId, { connector: 'bigchange' });
const glossary = await infra.matchGlossary(companyId, userQuery);

const context = {
  definitions: {
    revenue: 'invoices - credit_notes',  // from company_definitions
  },
  glossary: {
    'parent contact': 'BigChange ParentContactId — billing account holder',
  },
};

// BigChange query tool applies revenue rule before returning
const result = await bigchange.querySales({ month: '2026-01', apply: context.definitions });
```

The **AI model** receives correct data because the **MCP tool** applied the rule — not because the AI “remembered” from last week’s chat.

### 22.8 Worked examples

**EL Business — revenue calculation**

| Field | Value |
| --- | --- |
| slug | `revenue` |
| rule | `invoices - credit_notes` |
| connector | `bigchange` |
| approved_by | `charlie@el.example` |

**HT Business — different revenue rule**

| Field | Value |
| --- | --- |
| slug | `revenue` |
| rule | `invoices + performers - credit_notes` |
| connector | `commusoft` |

**EL Business — BigChange glossary**

| term | definition | api_hint |
| --- | --- | --- |
| parent contact | Billing account holder in BigChange | `{ "field": "ParentContactId", "contactType": "Parent" }` |
| TEMP reference | Exclude SI references starting with TEMP | `{ "excludePrefix": "TEMP" }` |

### 22.9 Definitions + automations + WhatsApp

All channels read the **same approved definitions**:

```
ChatGPT request  ──┐
Cursor automation ─┼──→ INFRA definitions service ──→ EL MCP ──→ BigChange
WhatsApp (future) ─┘
```

An automation that runs at 8am to send Commusoft quotes uses the same glossary and filters as a ChatGPT conversation — no duplicate rules in Cursor scripts.

Cursor-built automations should **read** definitions from INFRA at runtime, not hard-code business rules in script files (except as fallback during early development).

### 22.10 Phasing

| Phase | Capability |
| --- | --- |
| **v0.1** | Manual definition authoring via Cursor → INFRA API or YAML; MCP reads definitions; corrections logged to audit only |
| **v0.2** | Correction proposals UI; owner approval in company portal; glossary management |
| **v0.3** | Auto-suggest after repeated corrections; definition versioning UI; impact preview (“this changes revenue reporting”) |

### 22.11 Risks

| Risk | Mitigation |
| --- | --- |
| Wrong rule approved → bad reporting | Versioning, approval gate, audit trail, deprecate not delete |
| Cross-tenant rule leak | Strict `company_id` on all definition queries |
| AI silently “learns” wrong thing | Proposals require approval; no auto-write to Tier 2 |
| Rules drift from Cursor scripts | Automations fetch definitions from INFRA at runtime |
| Too many definitions → context bloat | Load only relevant definitions per connector/query; glossary keyword match |

| Rules drift from Cursor scripts | Automations fetch definitions from INFRA at runtime |
| Too many definitions → context bloat | Load only relevant definitions per connector/query; glossary keyword match |

---

## 23. Read/write commands and role-based tool access

INFRA and company MCP environments must support **both read and write** operations invoked via natural language in ChatGPT, Claude, WhatsApp (future), or Cursor. Every action passes through INFRA for **permission check → metering → audit** before the MCP executes against BigChange, Commusoft, Xero, etc.

### 23.1 Read vs write — same path, different gates

```
User (any channel): natural language request
        ↓
AI interprets intent → selects MCP tool
        ↓
INFRA gateway:
    1. Identify user + company + role
    2. Map tool to action (e.g. bigchange.jobs.book_engineer)
    3. Check role preset — allowed?
    4. Check risk class — approval required?
    5. Check credit balance
    6. Issue request_id
        ↓
Company MCP executes tool against live system
        ↓
INFRA: usage event → ledger debit → audit log
        ↓
Response to user
```

**Read and write use the identical pipeline.** Writes add stricter permission and risk checks.

### 23.2 Worked examples

#### Example A — Read (Engineer)

```
John (Engineer) in ChatGPT:
"When is engineer number 7 booked in for a job?"

AI tool: bigchange.engineers.schedule.read({ engineerId: 7 })

INFRA check:
    user: john@el.example
    role: engineer
    action: bigchange.engineers.schedule.read
    risk: LOW_RISK
    result: ALLOW ✓

MCP → BigChange → returns schedule
INFRA → meter read (£0.05) → audit
ChatGPT → "Engineer 7 is booked Tuesday 2pm, Job #4521"
```

#### Example B — Write denied (Engineer)

```
John (Engineer):
"Book engineer 7 into a job tomorrow at 9am"

AI tool: bigchange.jobs.book_engineer({ engineerId: 7, ... })

INFRA check:
    role: engineer
    action: bigchange.jobs.book_engineer
    risk: WRITE
    result: DENY ✗ (not in engineer preset)

ChatGPT → "You don't have permission to book jobs. Contact office staff."
Audit → permission.denied logged (no charge)
```

#### Example C — Write allowed (Office Staff)

```
Sarah (Office Staff):
"Book engineer 7 into a job tomorrow at 9am for customer ABC Ltd"

AI tool: bigchange.jobs.book_engineer(...)

INFRA check:
    role: office_staff
    action: bigchange.jobs.book_engineer
    result: ALLOW ✓

MCP → BigChange → job booked
INFRA → meter write (£0.80) → audit
ChatGPT → "Done — Job #4522 booked for engineer 7, tomorrow 9am"
```

#### Example D — Financial write (Manager)

```
Mike (Manager):
"Raise an invoice for £100 for job 4522"

AI tool: bigchange.invoices.create({ jobId: 4522, amount: 10000 })

INFRA check:
    role: manager
    action: bigchange.invoices.create
    risk: FINANCIAL_ACTION
    result: ALLOW ✓

MCP → BigChange → invoice created
INFRA → meter financial_action (£1.20) → audit (amount, job, user)
ChatGPT → "Invoice SI-12345 raised for £100.00 ex VAT"
```

#### Example E — PO creation (Office Staff)

```
Sarah (Office Staff):
"Raise a purchase order for £250 materials on job 4522"

AI tool: bigchange.purchase_orders.create(...)

INFRA check:
    role: office_staff
    action: bigchange.purchase_orders.create
    result: ALLOW ✓
```

### 23.3 MCP tools expose read AND write capabilities

Each connector declares capabilities (`READ`, `CREATE`, `UPDATE`, `DELETE`, `SEND`, etc.). MCP tools map to ** granular actions** enforced by role presets:

| MCP tool | Action key | Capability | Typical roles |
| --- | --- | --- | --- |
| `bigchange.engineers.schedule.read` | Read schedule | READ | Engineer+ |
| `bigchange.jobs.read_assigned` | Read own jobs | READ | Engineer+ |
| `bigchange.jobs.book_engineer` | Book engineer to job | UPDATE | Office Staff+ |
| `bigchange.jobs.create` | Create new job | CREATE | Office Staff+ |
| `bigchange.purchase_orders.create` | Raise PO | CREATE | Office Staff+ |
| `bigchange.invoices.create` | Raise invoice | CREATE | Supervisor+ |
| `bigchange.invoices.delete` | Delete invoice | DELETE | Director (approval) |
| `commusoft.quotes.send` | Send quote to customer | SEND | Manager+ |

Implementation lives in company MCP (customer data plane). INFRA holds role presets and enforces on every call.

### 23.4 Role preset source of truth

```
packages/shared/src/permissions/role-presets.ts
    ↓ deployed with INFRA API
D1: company_user_roles (user_id, company_id, role)
    ↓ checked at runtime
INFRA permission service: isActionAllowed(role, action)
```

Preset roles: `engineer`, `junior_office`, `office_staff`, `supervisor`, `manager`, `director`, `company_admin`.

Charlie (Owner) assigns John as `engineer`, Sarah as `office_staff`, Mike as `manager` in the company portal.

### 23.5 High-risk writes and approval (future)

| Action | Risk | v0.1 | v0.2+ |
| --- | --- | --- | --- |
| Read schedule | LOW_RISK | Auto-allow if role permits | Same |
| Book job | WRITE | Auto-allow if role permits | Same |
| Raise invoice < £500 | FINANCIAL_ACTION | Auto-allow for Manager+ | Same |
| Raise invoice > £500 | FINANCIAL_ACTION | Allow + audit flag | Optional approval queue |
| Delete invoice | DELETE | Deny except Director | Approval required |
| Batch send 50 quotes | BATCH_WRITE | Deny | Director approval |

Schema supports approval workflow later without changing role presets.

### 23.6 Natural language → tool mapping

The AI model (ChatGPT/Claude/gateway) chooses tools. INFRA does **not** parse natural language — it enforces **which tools each user may invoke**.

Company definitions (Section 22) help the AI interpret terms ("revenue", "parent contact"). Role presets control **what it is allowed to do** once it has interpreted the request.

### 23.7 Automations use the same permission model

Cursor-built automations run as a **service identity** (e.g. `automation:ht-send-quotes`) with its own role/grant — not as a human user. Permissions are granted explicitly when the automation is wired up.

---

## Gap analysis: current scaffold vs v0.1 spec

| Requirement | Status |
| --- | --- |
| Admin web application | Partial — 4 pages, needs full nav |
| Authentication | Not started |
| Company registry + 3 tenants | Done (seeded) |
| Connector catalogue | Done |
| Connector instance model | Done (DB + API) |
| MCP environment registry | Partial — missing health endpoint, auth ref, version, capabilities |
| AI client registry | Not started |
| Capability/permission foundations | Partial — needs risk classes |
| User/role foundation | Not started |
| Usage event model | Partial — basic schema only |
| Immutable billing ledger | Not started |
| Credit balance | Partial — cached balance only |
| Pricing rules/versioning | Not started |
| Stripe test mode | Not started |
| MCP/connector health | Partial — manual health check |
| Audit log | Partial — basic events |
| System health dashboard | Not started |
| Caddington MCP registration | Done |
| Simulated billing test | Not started |
| Visual prototype | Done (admin + EL company portal) |
| Company definitions engine | Designed — not implemented (Section 22) |
| Read/write tool permissions + role presets | Presets defined in shared package (Section 23) |
| Company portal (tenant view) | Prototype only |

---

## Security: former-company rule

INFRA has **no connection** to legacy Nirvana, Aquilo, or Urban Maintenance. No reuse of live credentials. Historical code may inform connector design only.

Before enabling any external connection, document: company, service, account/tenant, permissions, read/write/delete/batch/send capabilities — and obtain explicit approval.

---

## Related documents

| Document | Contents |
| --- | --- |
| `infra/docs/SETUP-GUIDE.md` | Go-live: hosting, domain, Cloudflare, Stripe, phased checklist |
| `infra/docs/CURSOR-BRIDGE.md` | Cursor ↔ INFRA escalation when AI/MCP is unsure about APIs |
