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
```

Customer documents, vectors, CRM records, and API credentials **never** live in the control-plane D1.

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

| Role | Typical permissions |
| --- | --- |
| Standard User | search knowledge, read assigned jobs, limited notes |
| Supervisor | broader read on team data |
| Administrator | connector config, user management, higher-risk writes |
| Site Administrator | company-wide admin |
| Platform Owner | INFRA admin, billing, company setup |

Permissions enforced **server-side** on MCP tool invocation and connector operations.

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
| Visual prototype | In progress |

---

## Security: former-company rule

INFRA has **no connection** to legacy Nirvana, Aquilo, or Urban Maintenance. No reuse of live credentials. Historical code may inform connector design only.

Before enabling any external connection, document: company, service, account/tenant, permissions, read/write/delete/batch/send capabilities — and obtain explicit approval.
