# Business MCP Foundation — Project Checkpoint

**Checkpoint date:** 2026-08-24  
**Purpose:** Resume later without reconstructing chat history.  
**Status:** Foundation stage **COMPLETE** — secure, working, documented, tested. **No further development started.**

---

## Architecture overview

Three **company MCP Workers** share one npm monorepo and **`@business-mcp/core` v1.0.0**:

```
packages/business-mcp-core/     ← shared library (not a deployed Worker)
workers/caddington-mcp/         ← reference knowledge MCP (production, untouched in Phases 2–5)
workers/ht-business-mcp/        ← HT structured-data MCP (Core-aligned, secured)
workers/el-business-mcp/        ← EL clean foundation MCP (Core-native)
```

**Isolation rule:** Shared **code** only. Each company has its own Worker, D1, secrets, and (when provisioned) R2/Vectorize/Queue resources. No cross-company bindings or credentials.

```
                    ┌─────────────────────────┐
                    │  @business-mcp/core     │
                    │  v1.0.0                 │
                    └───────────┬─────────────┘
          ┌─────────────────────┼─────────────────────┐
          ▼                     ▼                     ▼
   caddington-mcp        ht-business-mcp       el-business-mcp
   (REFERENCE)           (CORE-ALIGNED)        (CORE-NATIVE)
   Knowledge proven      Structured data       Framework only
   Google Drive          Phase 2 warehouse     No live connectors
```

---

## Current environments

### Caddington MCP — REFERENCE / OPERATIONAL

| Item | Value |
|------|-------|
| Company | Caddington |
| Worker | `caddington-mcp` |
| URL | https://caddington-mcp.daniel-dwyer123.workers.dev |
| MCP endpoint | `/mcp` |
| MCP version | 1.0.0 (on `cursor/caddington-mcp-915a` branch) |
| Core version | Not aligned — standalone codebase |
| D1 | `caddington-business-data` (`2837bf7d-cf76-4920-84b9-48c4d2fe16db`) |
| R2 | `caddington-knowledge` |
| Vectorize | `caddington-knowledge-index` |
| Workers AI | Bound (`AI`) |
| Queue | `caddington-gdrive-sync` (producer + consumer) |
| Cron | Hourly (`0 * * * *`) + scheduled Drive scan |
| Knowledge | **OPERATIONAL** — Google Drive source, hybrid retrieval |
| Structured data | Present (warehouse tables) |
| MCP auth | Legacy: open when `MCP_AUTH_TOKEN` unset |
| Admin auth | `/admin/*` routes (separate token) |
| Health | `GET /health` → `{ ok, service }` |
| Extended status | Not exposed at `/status` |
| **Do not modify** without explicit approval — proven production reference |

**Tools:** `system_health`, `database_summary`, `query_business_data`, `search_company_knowledge`, `get_knowledge_document`

---

### HT Business MCP — CORE-ALIGNED / OPERATIONAL

| Item | Value |
|------|-------|
| Company | HT Business |
| Worker | `ht-business-mcp` |
| URL | https://ht-business-mcp.daniel-dwyer123.workers.dev |
| MCP endpoint | `/mcp` |
| MCP version | **0.2.1** |
| Core version | **1.0.0** |
| D1 | `ht-business-data` (`4bbce2f7-94d0-44f0-b6d8-4fc92c8055f0`) |
| R2 / Vectorize / AI / Queue / Cron | **NOT_PROVISIONED** |
| Knowledge | **NOT_CONFIGURED** (tools return `not_configured`) |
| Structured data | **POPULATED** — Phase 2 dummy warehouse (~1,445 operational rows) |
| Connector registry | **FRAMEWORK EXISTS** — 5 placeholders, all `not_configured` |
| MCP auth | **FAIL-CLOSED** — `MCP_AUTH_TOKEN` required (Cloudflare secret) |
| Admin auth | Not implemented |
| Health | `GET /health` public (safe liveness only) |
| Extended status | `GET /status` — **requires MCP Bearer token** |
| Branch / PR | `cursor/ht-core-alignment-915a` — PR #289 |

**Tools:** `system_health`, `database_summary`, `query_business_data`, `search_company_knowledge` (not_configured), `get_knowledge_document` (not_configured)

**D1 migrations:** `0001_init`, `0002_phase2_operational`, `0003_ht_connector_framework` (all applied remotely)

---

### EL Business MCP — CORE-NATIVE / FRAMEWORK

| Item | Value |
|------|-------|
| Company | EL Business |
| Worker | `el-business-mcp` |
| URL | https://el-business-mcp.daniel-dwyer123.workers.dev |
| MCP endpoint | `/mcp` |
| MCP version | **1.0.0** |
| Core version | **1.0.0** |
| D1 | `el-business-data` (`df4c2b7c-62f6-42a6-9e26-59e7836fd1a7`) |
| R2 / Vectorize / AI / Queue / Cron | **NOT_PROVISIONED** |
| Knowledge | **NOT_CONFIGURED** |
| Structured data | **FRAMEWORK EXISTS, DATA EMPTY** (`dataStatus: empty`) |
| Connector registry | 6 placeholders (BigChange, SharePoint, OneDrive, Xero, Outlook, Freshdesk) |
| MCP auth | **FAIL-CLOSED** — `MCP_AUTH_TOKEN` + `EL_ADMIN_TOKEN` |
| Admin auth | `/admin/connectors` requires `EL_ADMIN_TOKEN` |
| Health | `GET /health` public |
| Extended status | `GET /status` public (no secrets; shows framework-only state) |
| Branch / PR | `cursor/el-business-mcp-915a` — PR #288 |

**Tools:** Same five as HT pattern (knowledge tools return `not_configured`)

---

## Version summary

| Component | Version | Notes |
|-----------|---------|-------|
| `@business-mcp/core` | 1.0.0 | Shared library |
| HT MCP | 0.2.1 | 0.2.0 Core alignment + 0.2.1 auth hardening |
| EL MCP | 1.0.0 | Clean Core-native foundation |
| Caddington MCP | 1.0.0 | Independent; not Core-aligned |

---

## Security model

| Environment | MCP auth | Admin auth | `/health` | `/status` |
|-------------|----------|------------|-----------|-----------|
| Caddington | Open when token unset (legacy) | Bearer token when configured | Public | N/A |
| HT | **Fail-closed** (`requireToken: true`) | N/A | Public | **Protected** (Bearer) |
| EL | **Fail-closed** | `EL_ADMIN_TOKEN` for `/admin/*` | Public | Public (safe metadata) |

**Rules enforced in foundation close-out:**
- Secrets stored **only** as Cloudflare Worker secrets
- Never in source, git, D1, logs, or health/status responses
- HT token is HT-specific; EL tokens are EL-specific; no cross-company reuse

**HT token location for operator:** Generated at close-out and stored as Worker secret `MCP_AUTH_TOKEN`. One-time local copy (not in git): `.secrets/ht-mcp-auth-token` on the build VM — **copy to your password manager and delete the local file when done.**

---

## Status terminology

Distinguish **framework exists** from **real business data connected**:

### Structured data

```json
{
  "status": "healthy",
  "frameworkStatus": "configured",
  "dataStatus": "not_connected | empty | populated",
  "mode": "warehouse",
  "tables": 15,
  "records": 1451,
  "operationalRecords": 1445
}
```

| Company | frameworkStatus | dataStatus | Meaning |
|---------|-----------------|------------|---------|
| EL | configured | **empty** | D1 framework tables only; no operational business rows |
| HT | configured | **populated** | Phase 2 warehouse with dummy operational data |
| Caddington | configured | populated | Live business + knowledge data |

Legacy field `status` retained for backward compatibility.

### Knowledge pipeline

Values: `not_configured` → `configured` → `syncing` → `indexed` | `error`

| Company | knowledge.status |
|---------|------------------|
| Caddington | indexed (operational) |
| HT | not_configured |
| EL | not_configured |

---

## Business MCP Core v1.0.0

### A. Complete and proven

- Structured logging (`createLogger`)
- Read-only SQL safety (`validateReadOnlySql`, `appendLimitIfMissing`)
- D1 health probes and summaries (`checkDatabaseHealth`, `getDatabaseSummary`, `runReadOnlyQuery`)
- Health/status builders (`buildLivenessHealthResponse`, `buildExtendedHealthResponse`, `buildStructuredDataHealthSummary`)
- MCP auth helpers (`checkMcpAuth`, fail-closed `requireToken`)
- Admin auth helpers
- Version reporting (`CORE_VERSION`)
- Connector types, capabilities, schedule, sync-eligibility, not-configured stubs
- Knowledge metadata types and normalised-document interfaces
- Retrieval utilities (query-parse, routing, ranking, confidence guidance)
- Document chunking
- Reference SQL schemas (`schema/warehouse.sql`, `schema/knowledge.sql`)
- **47 unit tests passing**

### B. Implemented but not yet proven across multiple company MCPs

- Extended health/status contract (HT + EL use it; Caddington does not)
- Connector registry D1 pattern (HT + EL; placeholders only)
- Knowledge tool stubs returning `not_configured` (HT + EL)
- Structured-data status model (`frameworkStatus` / `dataStatus`)

### C. Still company-specific

- MCP server tool registration (per-worker `mcp-server.ts`)
- Company table allowlists and summary config
- HT Phase 2 seed/analytics scripts
- Caddington Google Drive connector, queue consumer, cron, extraction, hybrid search runtime
- EL admin routes

### D. Deferred (not in Core v1.0.0)

- Reusable knowledge ingestion runtime (extraction, FTS, embeddings, hybrid orchestration)
- MCP server factory
- Queue consumer framework
- Scheduled source sync framework
- Document extraction adapters
- Live connector implementations (Commusoft, BigChange, Xero, Microsoft 365, etc.)
- INFRA registration client
- Billing/usage metering
- WhatsApp channel

**Knowledge accuracy note:** The full reusable knowledge runtime has **NOT** been proven outside Caddington. Caddington remains the only environment with live indexed knowledge (Google Drive). Proving source-neutral knowledge requires a second source (recommended: Microsoft SharePoint/OneDrive).

---

## Knowledge architecture (target — not implemented platform-wide)

```
Source Connector
        ↓
NormalisedDocument
        ↓
Common ingestion runtime   ← DEFERRED in Core
        ↓
R2
        ↓
Extraction (Workers AI)
        ↓
Chunking
        ↓
D1 / FTS
        ↓
Vectorize
        ↓
Hybrid retrieval
        ↓
Company MCP tools (search_company_knowledge, get_knowledge_document)
```

**Caddington** implements this end-to-end for Google Drive. **HT** and **EL** have schema/interfaces/stubs only.

---

## INFRA registration contract (recommended — not connected)

Minimum machine-readable contract for future INFRA monitoring:

```json
{
  "companyId": "ht-business",
  "companyName": "HT Business",
  "environment": "production",
  "mcpUrl": "https://ht-business-mcp.daniel-dwyer123.workers.dev/mcp",
  "mcpVersion": "0.2.1",
  "coreVersion": "1.0.0",
  "statusUrl": "https://ht-business-mcp.daniel-dwyer123.workers.dev/status",
  "healthUrl": "https://ht-business-mcp.daniel-dwyer123.workers.dev/health",
  "capabilities": ["READ", "SEARCH"],
  "knowledgeStatus": "not_configured",
  "structuredDataStatus": {
    "frameworkStatus": "configured",
    "dataStatus": "populated",
    "mode": "warehouse"
  },
  "connectors": [
    { "type": "commusoft", "status": "not_configured", "enabled": false }
  ],
  "authentication": {
    "mcp": "bearer_token_required",
    "statusEndpoint": "bearer_token_required"
  }
}
```

**Registration flow (future):** INFRA polls `healthUrl` for liveness, `statusUrl` (with stored per-company token) for extended state, registers in monitoring catalog. **Not implemented in this checkpoint.**

---

## Environment comparison table

| | CADDINGTON | HT | EL |
|---|------------|----|----|
| Company | Caddington | HT Business | EL Business |
| Environment | production | production | production |
| Worker | caddington-mcp | ht-business-mcp | el-business-mcp |
| MCP endpoint | /mcp | /mcp | /mcp |
| MCP version | 1.0.0 | 0.2.1 | 1.0.0 |
| Core version | N/A (standalone) | 1.0.0 | 1.0.0 |
| MCP authentication | OPEN_WHEN_UNSET (legacy) | FAIL-CLOSED | FAIL-CLOSED |
| Admin authentication | Configured (separate) | NOT_CONFIGURED | FAIL-CLOSED |
| D1 | CONNECTED | CONNECTED | CONNECTED |
| R2 | CONNECTED | NOT_PROVISIONED | NOT_PROVISIONED |
| Vectorize | CONNECTED | NOT_PROVISIONED | NOT_PROVISIONED |
| Workers AI | CONNECTED | NOT_PROVISIONED | NOT_PROVISIONED |
| Queue | CONNECTED | NOT_PROVISIONED | NOT_PROVISIONED |
| Cron | CONNECTED | NOT_PROVISIONED | NOT_PROVISIONED |
| Knowledge engine | OPERATIONAL | NOT_CONFIGURED | NOT_CONFIGURED |
| Knowledge source | Google Drive | — | — |
| Structured data | POPULATED | POPULATED (warehouse) | FRAMEWORK ONLY (empty) |
| Connector registry | OPERATIONAL (Drive) | FRAMEWORK (5 placeholders) | FRAMEWORK (6 placeholders) |
| Health endpoint | PUBLIC | PUBLIC | PUBLIC |
| Extended status | NOT_EXPOSED | PROTECTED | PUBLIC |
| MCP tools | 5 | 5 | 5 |
| Document count (knowledge) | Indexed (live) | 0 | 0 |
| Connector count (configured) | 1+ live (Drive) | 0 live | 0 live |
| INFRA readiness | PARTIAL (legacy auth) | READY | READY |
| Deployment status | OPERATIONAL / REFERENCE | OPERATIONAL / CORE-ALIGNED | OPERATIONAL / CORE-NATIVE |

---

## Future development roadmap (documented only — NOT started)

Recommended technical order when resuming:

1. **Secure Caddington MCP auth** (align to fail-closed without breaking existing clients)
2. **Prove reusable knowledge runtime** with Microsoft SharePoint/OneDrive on EL (second source)
3. **Extract Caddington knowledge pipeline into Core** once proven source-neutral
4. **INFRA registration** — implement polling against `/health` + authenticated `/status`
5. **EL connectors** — BigChange (structured), then SharePoint/OneDrive (knowledge)
6. **HT connectors** — Commusoft (structured), then SharePoint/OneDrive (knowledge)
7. **Finance connectors** — Xero (HT + EL)
8. **Email** — Outlook shared mailbox (HT + EL)
9. **Support** — Freshdesk (EL)
10. **Platform** — billing/usage, WhatsApp (later)

---

## Known limitations

- Caddington not on Core; not modified during foundation work
- Caddington MCP auth still open when token unset
- Knowledge runtime not reusable; only proven on Caddington + Google Drive
- HT/EL knowledge tools are stubs only
- No live external connectors on HT or EL
- INFRA not connected
- HT `/status` requires auth (INFRA must store HT token)

---

## Testing commands

```bash
# Core unit tests
npm test

# HT unit tests
cd workers/ht-business-mcp && npm test

# HT live e2e (requires token)
HT_MCP_AUTH_TOKEN=... node workers/ht-business-mcp/scripts/e2e-health.mjs

# HT analytics regression
MCP_AUTH_TOKEN=... node workers/ht-business-mcp/scripts/phase2-mcp-analytics.mjs

# EL live e2e
EL_MCP_URL=https://el-business-mcp.daniel-dwyer123.workers.dev \
EL_MCP_AUTH_TOKEN=... EL_ADMIN_TOKEN=... \
node workers/el-business-mcp/scripts/e2e-health.mjs
```

---

## Deployment commands

```bash
# HT
cd workers/ht-business-mcp
npx wrangler deploy
npx wrangler d1 migrations apply ht-business-data --remote   # if pending
npx wrangler secret put MCP_AUTH_TOKEN                        # if rotating

# EL
cd workers/el-business-mcp
npx wrangler deploy
npx wrangler d1 migrations apply el-business-data --remote

# Caddington — do not deploy from foundation branches without explicit approval
```

---

## Pull requests / branches

| Phase | Branch | PR | Status |
|-------|--------|-----|--------|
| Core v1.0.0 | `cursor/business-mcp-core-915a` | #287 | Merged foundation |
| EL MCP | `cursor/el-business-mcp-915a` | #288 | Deployed |
| HT Core alignment + close-out | `cursor/ht-core-alignment-915a` | #289 | Deployed, secured |

---

## Cost footprint (estimated)

| Resource | Caddington | HT | EL |
|----------|------------|----|----|
| Workers | 1 | 1 | 1 |
| D1 | 1 | 1 | 1 |
| R2 | 1 | 0 | 0 |
| Vectorize | 1 | 0 | 0 |
| Workers AI | usage | 0 | 0 |
| Queues | 1 | 0 | 0 |

HT and EL are minimal-cost (Worker + D1 free-tier footprint). Caddington incurs knowledge storage, Vectorize, AI extraction, and queue costs from live Google Drive sync.

---

## Important operational notes

- **Never reseed HT D1** operational data without explicit approval — Phase 2 analytics depend on it
- **Never reuse secrets** across companies
- **Never bind** HT/EL workers to Caddington or cross-company D1 IDs
- When rotating HT `MCP_AUTH_TOKEN`, update all MCP clients and INFRA credential stores
- `.secrets/` is gitignored — for one-time operator token pickup only

---

*Foundation checkpoint — development paused. Await explicit approval before starting new streams.*
