# ADR 005 — Action classification and future approvals

- **Status:** Accepted (schema only; enforcement off)
- **Date:** 2026-08-24
- **Depends on:** ADR 001
- **Applies to:** gateway allowlists, future write connectors

---

## Context

Future company capabilities include financial writes and external sends. Those must not run tonight. INFRA still needs a stable vocabulary so later work does not invent a second permission model.

AI instructions are **never** the security boundary. Server-side allowlists + role presets are.

---

## Decision

Classify actions as:

| Class | Examples | Approval (future) |
| --- | --- | --- |
| `read` | knowledge.search, knowledge.read, warehouse query | No |
| `system` | system.health, tool discovery | No (and not billable) |
| `write` | Book engineer | Yes |
| `financial_action` | Raise invoice, raise PO | Yes |
| `external_send` | Send quote, WhatsApp | Yes |
| `delete` | Delete records | Yes |
| `batch_write` | Batch update | Yes |
| `high_risk` | Catch-all for unmapped writes | Yes |

Table `action_classifications` (migration 0009) stores labels and `requires_approval`. Gateway **does not** enforce approvals yet. Unmapped tools remain `high_risk` and stay off the allowlist unless explicitly enabled.

Role presets (Engineer, Junior Office, Office Staff, Supervisor, Manager, Director, Company Admin) remain the customer-facing model. Platform Admin is separate. Advanced per-user overrides may come later.

---

## Out of scope tonight

- Live financial writes
- Approval inbox UI
- Vendor connector implementations (BigChange, Commusoft, Xero, OneDrive, SharePoint, Freshdesk, WhatsApp)
