# ADR 030 — Company data platform / warehouse (planning only)

- **Status:** Proposed (planning — do not build yet)
- **Date:** 2026-08-25
- **Depends on:** ADR 001, ADR 029
- **Applies to:** future Company MCP data layer

---

## Context

Today INFRA and Company MCP query **live source APIs** (Xero, Google Drive, etc.) on demand. This works for operational questions and controlled writes but limits:

- Historical analytics without repeated API load
- Cross-system joins (Xero + Commusoft + BigChange)
- Fast knowledge retrieval at scale
- Offline/degraded-mode reads when a source is temporarily unavailable

---

## Proposed evolution

```
Business systems (Xero, Drive, BigChange, …)
        ↓ ingestion / synchronisation (Queues, Workflows)
Company-owned structured store (D1 per tenant or R2 parquet)
        ↓ optional Vectorize for semantic search
Company MCP (knowledge + warehouse tools)
        ↓
INFRA (identity, authz, metering, action engine)
        ↓
AI clients
```

**Writes always go to authoritative source systems** via the Action Engine — the warehouse is not the ledger.

---

## What stays live-source

| Data | Reason |
| --- | --- |
| Financial balances, invoice status, payment allocation | Must be authoritative from Xero at execution time |
| OAuth tokens, credentials | Never in warehouse |
| Action plan confirm/execute | Re-read live state (stale protection) |
| Real-time connector health | Live probe |

---

## What should be synchronised

| Data | Sync model | Store |
| --- | --- | --- |
| Contacts, invoices (metadata) | Incremental by `UpdatedDateUTC` | D1 or R2 |
| Drive file index + extracted text | Event/webhook + periodic reconcile | R2 + Vectorize |
| Job/appointment records (future) | Polling or webhook | D1 |
| Usage/audit (INFRA-owned) | Already in D1 | D1 |

---

## Source of truth

| Domain | Source of truth |
| --- | --- |
| Accounting | Xero (or future ERP) |
| Files | Google Drive / SharePoint |
| INFRA identity/billing | INFRA D1 |
| Warehouse copies | **Derived** — rebuildable from source |

---

## Incremental sync

1. Connector stores `last_sync_cursor` per resource type (timestamp or Xero `UpdatedDateUTC`).
2. Queue consumer fetches delta pages; idempotent upsert into company store.
3. Full reconcile job (weekly) detects drift vs live API sample.
4. Sync failures surface in connector health — do not silently serve stale financial data for writes.

---

## Historical analytics

- Time-series aggregates (monthly sales, P&L snapshots) materialised in D1 or R2.
- Live P&L remains Xero report API for operational accuracy until snapshot lag is acceptable and documented.
- Cross-system analytics join warehouse tables on `company_id` + normalised keys (contact_id, job_id).

---

## Cloudflare building blocks (when built)

| Component | Use |
| --- | --- |
| **D1** | Per-company metadata, sync cursors, small structured tables |
| **R2** | Document blobs, parquet exports, large extracts |
| **Vectorize** | Semantic search over ingested knowledge |
| **Queues** | Async ingestion workers |
| **Workflows** | Multi-step sync pipelines, retry, dead-letter |

No resources created in this planning phase.

---

## Interaction with Action Engine

Planning tools continue to **validate against live Xero** before confirm. Warehouse may accelerate **search/list** for AI context but must not replace live validation for financial execution.

---

## Next steps (future phase)

1. Define `company_data_sources` and sync cursor schema.
2. Xero read sync pilot (contacts + invoice headers, no writes from warehouse).
3. Reconcile job + staleness indicators in portal.
4. Vectorize backfill for Drive corpus already indexed.

**Do not start until Xero write acceptance is complete.**
