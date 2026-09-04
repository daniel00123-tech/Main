# INFRA Business Data Warehouse Standard

Reusable tenant-aware structured warehouse. **EL Xero is the first adapter**, not an EL-only architecture.

## Purpose

The warehouse is **not** the system of record.

- **Source systems** (Xero first) remain authoritative.
- The warehouse provides historical data, analytics, trends, fast aggregation, reduced API use, cross-period comparison, and management reporting.
- Current / right-now questions use the live source.

## Storage (V1)

**Cloudflare D1** (`infra-control-plane`).

Chosen because EL Xero volume is modest, query patterns are bounded aggregations, and D1 is already the control-plane store. Snowflake / BigQuery / Redshift / Databricks / external warehouse SaaS are out of scope unless D1 is proven inadequate.

Do not store unlimited raw API payloads. Persist normalised entities + meaningful snapshots.

Retention architecture: keep useful historical snapshots (designed for ~3 years). Never delete source Xero data.

## Tenant isolation

Every warehouse row includes authoritative `company_id`.

- EL: `co_el`
- Queries always bind `company_id` from the authorised company. Models cannot supply another tenant.
- Cross-tenant reads return empty.

## Connector adapters

Implement `WarehouseConnectorAdapter`:

- `extract({ companyId, checkpoint, now, trigger })`
- optional `liveTotals({ companyId, now })` for reconciliation

Future adapters (not implemented in V1): Commusoft, BigChange, CRM, tickets, other accounting systems.

## Layers

1. Source metadata / checkpoint (`warehouse_sources`)
2. Normalised current tables (`warehouse_xero_*`)
3. Historical snapshots (`warehouse_snapshots`)
4. Derived KPI snapshots (`warehouse_kpi_snapshots`)
5. Sync ledger (`warehouse_sync_runs`)

## EL Xero schedule

Timezone: **Europe/London** (DST-aware, never hardcoded year-round UTC).

- Monday–Friday: 07:00, 09:00, 11:00, 13:00, 15:00, 17:00, 19:00
- Saturday: 12:00
- Sunday: 12:00
- **37** opportunities / week
- No overnight, extra weekend, or hourly sync

Runs on the existing `infra-api` Worker crons (`* * * * *` and `*/15 * * * *`). **No new Worker.**

## Incremental sync

- Initial backfill: current financial year + prior financial year when Organisation FY-end is available.
- Incremental: Xero `If-Modified-Since` + pagination, checkpointed `sourceTimestamp`.
- Idempotent on `(company_id, xero_entity_id)`.
- Voided / deleted / archived entities stay stored but `is_current = 0`.
- One lock per company+connector. Competing runs are recorded `skipped_locked`.

## Reconciliation & health

After each successful extract, compare warehouse MTD sales / invoice count / outstanding / overdue (where live totals are available) to live Xero.

Tolerance: £0.02 absolute. Divergence → **DEGRADED**. Do not silently serve known-bad warehouse data. Do not rewrite financials to force a pass.

Health: `HEALTHY` | `DEGRADED` | `FAILED` | `NEVER_SYNCED`.

Freshness persisted: `warehouse_last_updated_at`, `source_last_updated_at`, `last_successful_sync`, `sync_status`.

## Query decision

Generic freshness classes (not phrase patches):

| Class | Preference |
| --- | --- |
| `HISTORICAL_ANALYTICAL` | warehouse |
| `CURRENT_LIVE_STATE` | live source |
| `CURRENT_BUT_WAREHOUSE_FRESH_ENOUGH` | warehouse if last success ≤ 2h, else live |
| `UNCERTAIN` | explain freshness honestly |

Fallback to live Xero when warehouse is missing, stale, degraded, or failed.

Evidence labels: `source = xero_live` or `source = xero_warehouse` plus `warehouse_as_of`.

Hybrid is allowed (warehouse history + live current MTD).

## Query capabilities

Bounded typed tools — **no arbitrary model SQL**, no D1 credentials:

- `warehouse_sales_analysis`
- `warehouse_invoice_analysis`
- `warehouse_receivables_analysis`
- `warehouse_customer_analysis`
- `warehouse_query` (approved aggregations only)

OpenAI (Portal / WhatsApp PA/request brain) selects tools; Cloudflare validates and executes; structured evidence returns; OpenAI synthesises.

ChatGPT MCP uses the **same tools directly** through the INFRA facade. OpenAI is not in front of ChatGPT.

## Billing

- Warehouse scheduled sync: `AUTOMATION` / internal. **0** EL 3p. No OpenAI tokens.
- Customer questions: unchanged 3p request pricing.
- Child warehouse query: **0** additional customer debit.

## Failure semantics

Telemetry categories (engineering feedback loop, no auto financial rewrite):

- `WAREHOUSE_SYNC_FAILED`
- `WAREHOUSE_STALE`
- `WAREHOUSE_RECONCILIATION_FAILED`
- `WAREHOUSE_QUERY_FAILED`
- `WAREHOUSE_SOURCE_DIVERGENCE`

## Security

Read-only Xero. No new Xero permissions. No credential rotation. No secret logging.

## Testing

Cover tenant isolation, backfill, incremental, duplicate sync, updates, paid/void, checkpoint, retry, lock, reconciliation, stale/degraded, live fallback, historical/fresh/multi-period query, billing, OpenAI evidence shape, ChatGPT MCP tools, schedule, DST, deploy guard.
