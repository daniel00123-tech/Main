# ADR 029 — Action Engine and controlled financial writes

- **Status:** Accepted
- **Date:** 2026-08-25
- **Depends on:** ADR 001, ADR 005, ADR 028
- **Applies to:** INFRA API, Company MCP, Xero connector (first implementation)

---

## Context

ChatGPT → INFRA → Caddington MCP → Xero **reads** are verified in production. The next capability is **controlled business-system writes** without giving ChatGPT uncontrolled direct financial access.

Principles:

- **Capability** at connector/MCP level (tools exist, bounded schemas)
- **Authority** at INFRA level (identity, company, role, permissions, risk class)
- **Execution** at Company MCP / source-system level (Xero remains authoritative)

Prompt wording must never increase authority.

---

## Decision

### Generic Action Engine

Provider-agnostic concepts in `@infra/shared/action-engine`:

| Concept | Purpose |
| --- | --- |
| `ActionDefinition` | Maps action id → risk class, billing, audit |
| `ActionPlanRecord` | Server-side execution plan (stored in `execution_plans`) |
| `ActionTarget` | Per-item live validation + proposed change |
| `PermissionDecision` | Server-side allow/deny + confirmation/approval flags |
| `RiskClassification` | `low_risk` … `delete` |
| `FinancialImpact` | Currency, total, direction, item count |

### Lifecycle

```
requested → validated → awaiting_confirmation → awaiting_approval → approved
  → executing → completed | partial_failure | failed | execution_uncertain
  | rejected | cancelled | expired | plan_stale
```

State transitions are server-controlled.

### Confirmation vs approval

- **Confirmation:** requester confirms the same server-side plan (`plan_id` + `confirmationToken`). ChatGPT must not resubmit financial details.
- **Approval:** separate approver (e.g. Director) when policy requires. Self-approval denied when requester === approver.

### MCP tools (INFRA-native)

Advertised to AI clients:

- `plan_xero_credit_invoices`, `plan_xero_draft_invoice`, `plan_xero_remittance_allocation`
- `get_action_plan`, `confirm_action_plan`, `cancel_action_plan`, `list_pending_actions`

Direct Xero write tools (`xero_create_draft_invoice`, etc.) remain **hidden** from `tools/list`. Execution routes through the action engine.

### Stale-state protection

Before confirm/execute, INFRA re-reads live Xero state and compares `plan_fingerprint`. Material change → `PLAN_STALE`, plan regeneration required.

### Idempotency

Separate layers: AI interaction id, action request idempotency key, plan id, per-operation idempotency. Duplicate idempotency key returns existing plan.

### Feature flags

```typescript
writesSupported: true      // architecture ready
writesEnabled: false       // global gate (FINANCIAL_WRITES_ENABLED)
financialWritesEnabled: false
destructiveWritesEnabled: false
```

Production financial writes stay **disabled** until operator explicitly enables `FINANCIAL_WRITES_ENABLED`.

> **Code update:** `infra/packages/api/src/services/approvals.ts` now sets `FINANCIAL_WRITES_ENABLED = true`. Direct MCP write tools remain blocked (`DIRECT_MCP_FINANCIAL_WRITES_BLOCKED`). See [`../../../docs/TENANCY_AND_SECURITY.md`](../../../docs/TENANCY_AND_SECURITY.md).

### Xero write scopes (granular, post–March 2026)

| Capability | Scope | Action | Risk |
| --- | --- | --- | --- |
| Draft invoice create/update | `accounting.invoices` | `xero.invoices.create` / `.update` | financial_action |
| Credit note + allocate | `accounting.invoices`, `accounting.payments` | `xero.credit_notes.create` / `.allocate` | financial_action |
| Payment allocation | `accounting.payments` | `xero.payments.allocate` | financial_action |
| Contact create/update | `accounting.contacts` | `xero.contacts.create` / `.update` | write |

Scope upgrade uses existing admin re-consent flow — never silent escalation.

### First safe write candidate

**Create draft ACCREC invoice (DRAFT status)** — non-final, visible in Xero, relatively reversible, lower risk than payment allocation.

### Database

Migration `0016_action_engine.sql` extends `execution_plans` with risk class, permission JSON, confirmation token hash, fingerprint, expiry, etc.

### Portal

`/portal/:slug/actions` — pending/completed action plans, targets, permission decision, audit timeline (via activity).

---

## Out of scope (this phase)

- Live production financial writes (`FINANCIAL_WRITES_ENABLED = false`)
- Full staff approval UX
- HT / EL activation
- 60% pricing / Stripe live

---

## Consequences

- ChatGPT can **discover** write capabilities via planning tools; **execution** requires INFRA permission + confirmation (+ approval when configured).
- Company MCP write handlers in `@infra/xero-core` are code-ready but gated.
- Future connectors (BigChange, Commusoft, banking) reuse the same Action Engine without Xero-specific naming in core services.
