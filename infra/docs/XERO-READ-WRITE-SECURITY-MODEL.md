# Xero read/write security model

**Status:** Accepted (governance audit, 2026-08-28)  
**Scope:** Caddington Holdings (`co_caddington`) and reusable INFRA Xero connector  
**Related:** ADR 005, ADR 027, ADR 028, ADR 029

---

## Executive principle

**Read and write are separate execution paths.** Diagnostic, search, reporting, and acceptance work must never mutate Xero. Controlled writes require explicit Action Engine intent, permission gates, and company write mode approval.

Ambiguous natural-language requests default to **READ ONLY**.

---

## Capability classification

Uses existing platform terminology (`riskClass`, `ActionRiskLevel`) — not a competing framework.

| Class | Examples | Mutation | Execution path |
| --- | --- | --- | --- |
| **READ_ONLY** | `xero_search_invoices`, `xero_get_invoice`, `xero_list_contacts`, `xero_sales_summary`, `xero_profit_and_loss` | `none` | Gateway → INFRA read execution or Company MCP |
| **WRITE_LOW_RISK** | `xero_create_draft_invoice`, `xero_update_draft_invoice`, `xero_create_contact` | `create` / `update` | Action Engine only |
| **WRITE_FINANCIAL** | `xero_approve_invoice`, `xero_send_invoice`, `xero_allocate_payment`, reconcile | `financial` | Action Engine + beta gates (many blocked in production) |
| **WRITE_DESTRUCTIVE** | `xero_void_invoice`, `xero_delete_draft_invoice` | `delete` | Action Engine + approval; blocked under CONTROLLED_WRITE |

Tool metadata is derived in `@infra/shared/connectors/xero-governance.ts`:

- `mutationType`: `none` | `create` | `update` | `delete` | `financial`
- `riskLevel`: `read` | `low` | `medium` | `high` | `critical`
- `requiresExplicitWriteIntent`, `requiresConfirmation`, `requiresApproval`

---

## Read-only execution guarantee (server-side)

Three layered blocks prevent read paths from mutating Xero:

1. **Tool discovery** — write MCP tools excluded from `tools/list` (`isXeroWriteToolName`)
2. **Gateway direct call** — `403 ACTION_ENGINE_REQUIRED` for any mutating tool name
3. **Read execution router** — `executeXeroReadToolOnInfra` rejects non-`low_risk` tools (`XERO_READ_ONLY_CONTEXT`)

Execution context modes:

| Mode | Purpose |
| --- | --- |
| `read_only` | Gateway reads, diagnostics, acceptance |
| `controlled_write` | Planning only (no direct MCP mutation) |
| `action_engine_execute` | Approved plan execution via Company MCP |

---

## Write execution (preserved, not removed)

Controlled writes remain available for Caddington when explicitly requested:

```
explicit write intent (plan_xero_* / portal action)
  → permission check (scopes + role)
  → Action Engine plan + confirmation
  → optional approval
  → FINANCIAL_WRITES_ENABLED gate
  → company write mode gate
  → idempotency claim
  → Company MCP write (X-Infra-Xero-Context)
  → read-back verification
  → audit event
```

**Direct MCP write tools are always blocked** at the gateway (`DIRECT_MCP_FINANCIAL_WRITES_BLOCKED = true`).

Higher-risk operations (send, allocate, void) remain gated by `XERO_WRITE_PRODUCTION_GATES` and `PLATFORM_XERO_SAFETY_CEILING`.

---

## Per-company write mode (kill-switch)

| Mode | Default | Behaviour |
| --- | --- | --- |
| `READ_ONLY` | New companies | All Xero mutations blocked (`XERO_COMPANY_READ_ONLY`) |
| `CONTROLLED_WRITE` | Caddington (`co_caddington`) | Draft invoice + approved low-risk writes via Action Engine |
| `FULL_APPROVED_WRITE` | Not enabled | Reserved for future operator approval |

Configured via `connector_instances.config_json.xeroWriteMode` (optional override).

---

## Natural-language intent

Read patterns (non-exhaustive): *show, list, find, search, check, analyse, report, overdue*  
Write patterns: *create, raise, draft, update, change, approve, send, void, delete, allocate*

Ambiguous phrases (read + write verbs) default to **read** at routing layer; writes require explicit `plan_xero_*` or portal action.

---

## Acceptance / diagnostic script policy

| Script type | Production writes |
| --- | --- |
| `probe`, `check`, `diagnostic`, `acceptance`, `read` | **Blocked** — read tools only |
| `write`, `draft-invoice-e2e` | Requires `ALLOW_XERO_PRODUCTION_WRITE=true` or `--allow-production-write` |

Guard: `infra/packages/api/scripts/lib/xero-script-guard.mjs`

---

## Automation Engine

Automations using MCP tool actions:

- **Cannot** invoke mutating Xero MCP tools
- **Cannot** call `plan_xero_*` or `execute_action_plan`

Read/report automations remain read-only by construction.

---

## Cross-tenant safety

- Connector instance validated against `companyId` before token resolution
- Service identity scoped to company
- Xero tenant binding on OAuth callback (tenant substitution blocked for BYO)
- `prepareXeroMcpExecution` rejects wrong-company connector references

---

## Audit logging

| Event | When |
| --- | --- |
| `permission.denied` | Write blocked (gateway, company READ_ONLY, read-only context) |
| `connector.connected` / action lifecycle | OAuth and Action Engine |
| Mutation execution | Action Engine execution records + audit (no tokens stored) |

Never log: access tokens, refresh tokens, client secrets.

---

## Idempotency

Action Engine uses execution plan fingerprints and `claimExecution` to prevent duplicate invoice creation on retry. Verified with mocks in `action-executor.test.ts` — not production.

---

## Historical write root cause (evidence)

Previous sessions that created/modified Xero records were **not** caused by read tools or generic search routing:

| Source | Evidence |
| --- | --- |
| **Explicit write acceptance scripts** | `probe-xero-write-alpha-20.mjs`, `probe-caddington-draft-invoice-e2e.mjs` — Action Engine plan → execute against production |
| **Operator gate enablement** | Git commit `860dd2d` — `FINANCIAL_WRITES_ENABLED` enabled for first-write acceptance |
| **User-requested draft invoice tests** | CMD7/CMD10/CMD11 UAT and ChatGPT draft invoice flow commits |
| **NOT read diagnostics** | Read tools route through GET/list handlers only; gateway blocks write tool names |

Read acceptance scripts (`probe-xero-no-mutation.mjs`, `probe-xero-read-acceptance.mjs`) use search/get only.

---

## Production diagnostic policy

**THIS AUDIT IS READ-ONLY AGAINST PRODUCTION XERO.**

Run: `node infra/packages/api/scripts/probe-xero-read-governance-acceptance.mjs`

Do not run write scripts without explicit `ALLOW_XERO_PRODUCTION_WRITE=true`.

---

## Microsoft regression (out of scope)

This audit does not modify Microsoft/Outlook configuration. CMD16C remains frozen.

---

## Files

| File | Purpose |
| --- | --- |
| `packages/shared/src/connectors/xero-governance.ts` | Metadata + execution gates |
| `packages/api/src/services/xero-company-write-mode.ts` | Per-company write mode |
| `packages/api/scripts/lib/xero-script-guard.mjs` | Acceptance script write guard |
| `packages/api/scripts/probe-xero-read-governance-acceptance.mjs` | Production read acceptance |
