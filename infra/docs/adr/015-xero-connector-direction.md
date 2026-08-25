# ADR 015 — Xero connector direction

- **Status:** Accepted (architecture only)
- **Date:** 2026-08-25
- **Depends on:** ADR 001, ADR 005, ADR 012

---

## Decision

Xero is a future **company Business MCP** connector, not an INFRA operational dataset.

Prepared in INFRA:

- catalogue definition (`conn_xero`)
- OAuth configuration schema (client id / secret / tenant — submission disabled)
- intended entities: contacts, invoices, payments, accounts, bank transactions, credit notes
- read vs write boundary: reads may be low-risk; writes are `financial_action` and require permission + future approval (ADR 005)

Unknowns (do not guess):

- exact Xero OAuth app scopes for the first live tenant
- which entities should be exposed to AI vs admin-only
- webhook vs scheduled sync for the first production tenant

Do not collect Xero credentials in this phase. Do not enable financial writes.
