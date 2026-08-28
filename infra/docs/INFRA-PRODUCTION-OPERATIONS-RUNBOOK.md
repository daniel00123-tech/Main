# INFRA Production Operations Runbook

Operator guide for running INFRA in production without inspecting Cloudflare, D1, queues, and provider consoles individually each morning.

## Platform health model

Operational summary states (presentation layer):

| State | Meaning |
|-------|---------|
| `HEALTHY` | No actionable issues |
| `DEGRADED` | Partial impact or elevated risk — monitor |
| `ATTENTION_REQUIRED` | Operator action likely needed |
| `OUTAGE` | Critical platform/tenant impact |
| `UNKNOWN` | Insufficient signal — not the same as healthy |

Severity: `INFO`, `WARNING`, `CRITICAL` (CRITICAL should be rare).

Underlying technical states (connector auth/sync/provider, MCP status, job statuses) are preserved — the operational model is a summary layer only.

## Where to look (Admin Control Panel)

| Question | Location |
|----------|----------|
| Is INFRA healthy? | **Dashboard** attention banner + **System Health** overall state |
| Which companies need attention? | **Companies** (filters) + System Health company summaries |
| Connectors failing? | **Connector Oversight**, **System Health**, Attention Centre |
| Automations failing/stuck? | System Health → Scheduled jobs / incidents |
| Billing problems? | **Billing**, **Pricing Rules** (reconciliation), Attention Centre |
| Recent failures? | **Failed Requests**, **Audit Log**, **Usage** |
| Knowledge sync issues? | Company portal Microsoft 365 page (customer-safe) + System Health incidents |

API (platform admin only):

- `GET /api/platform/operations/health` — aggregated operational health
- `GET /api/platform/attention` — actionable attention items (deduplicated)
- `POST /api/platform/operations/billing-reconciliation` — read-only billing diagnostic

Public endpoints remain minimal: `/health`, `/ready`.

## Subsystems monitored

- API / D1 / portal connectivity
- Business MCP environments
- Microsoft integration (scheduler, queue, Graph subscriptions, Outlook)
- Google Drive ingestion (MCP-managed — INFRA surfaces connector health)
- Xero (auth + connector health — governance blocks are not outages)
- Automation Engine (scheduler, stuck runs, HTTP fallback visibility)
- Stripe / billing / financial integrity exceptions
- Knowledge indexing queue health
- Outbound transactional email (when configured)

## Company health

Per-company operational summary includes:

- Overall state
- Connector / billing / automation / knowledge issue counts
- Last successful platform activity (usage timestamp)
- Attention item count

Company users see simplified customer health only (`Healthy`, `Attention needed`, etc.) — never worker IDs, queue names, or provider stack traces.

## Connector health

Reuses ADR 022 three-dimensional model:

1. **Auth** — OAuth/credential state
2. **Sync** — last successful sync, stale detection for enabled schedules
3. **Provider** — upstream API health

**Stale connector detection:** enabled connectors with no successful sync within expected interval (Microsoft ~24h, Google Drive ~48h, Xero ~72h). Naturally inactive/manual connectors are not flagged.

## Knowledge ingestion

Microsoft: queue job stats, dead-letter counts, stale `processing`/`retrying` jobs, Graph subscription expiry.

OCR V1 (Azure Document Intelligence `prebuilt-read`): only for `requires_ocr` documents. Operator status appears on System Health knowledge metrics (`ocrCompleted` / `ocrFailed` / `ocrPending`). See `INFRA-MICROSOFT-OCR-V1.md`. Do not mass-reprocess the corpus.

Google Drive: whole-drive continuation runs in company MCP — INFRA monitors connector/MCP health and usage anomalies; do not reindex entire Drive during routine ops checks. Drive image exclusion is unchanged.

## Automation Engine

- Scheduler heartbeat recorded each cron run
- Stuck run detection: `running`/`queued` > 45 minutes
- Processing mode visible: Cloudflare queue vs HTTP fallback
- Financial automations are never auto-retried beyond existing engine policy

## Billing reconciliation

Read-only diagnostic (`runBillingReconciliationDiagnostic`):

- Detects open `financial_integrity_exceptions`
- Heals link-only usage↔ledger gaps (never auto-debits)
- Flags duplicate wallet top-ups / missing credits

Do not trigger charges or alter wallet balances from diagnostics.

## Auth & security signals

Distinguished operationally:

- Invalid credentials (expected user failures — pattern-based only)
- Disabled user / expired session / credentialsVersion invalidation
- Repeated cross-tenant permission denials (CRITICAL)
- Financial-write governance denials (SECURITY_POLICY — not platform outage)

Audit events retain evidence; tokens/secrets are never logged.

## Failure deduplication

Repeated identical incidents within a 2-hour window are grouped in operator views:

> Microsoft sync failed 18 times in 2 hours

Raw audit/job rows remain for investigation.

## Incident response

1. Check **System Health** overall state and open incidents
2. Review recommended action on incident row
3. Drill into company portal or Failed Requests as needed
4. Consult `docs/runbooks/` for subsystem-specific guides
5. After recovery, verify state returns to `HEALTHY` — history is preserved

## Safe production diagnostics

Allowed (read-only):

- System Health refresh
- Billing reconciliation diagnostic
- Internal acceptance route (token-protected): `POST /api/internal/operations/acceptance`

Not allowed during routine ops:

- Xero financial mutations
- Stripe charges / auto top-up triggers
- Mass email sends
- Drive reindex / mailbox mass sync
- User/company deletion

## Known limitations

- Google Drive continuation state lives in company MCP — INFRA shows connector-level health, not per-page token detail
- Automation queue binding may be unavailable — HTTP fallback is used and surfaced to operators
- Cloudflare invoice cost is not available inside INFRA — usage anomaly flags only
- Outbound email operator alerts are not auto-enabled — integration point exists for future typed notifications

## Troubleshooting quick reference

| Symptom | First check |
|---------|-------------|
| Platform degraded | System Health → subsystems |
| One company only | Company filter on Dashboard; company summary row |
| Microsoft stale | Scheduler heartbeat, subscription expiry incidents |
| Automation stuck | Stuck run incident; Automation portal page |
| Billing mismatch | Pricing Rules → reconciliation; open FIE count |
| Auth spike | Audit log `auth.login_failed` pattern (not single failures) |
| Permission spike | Audit log `permission.denied`; cross-tenant count |
