# ADR 015 — Xero connector direction

- **Status:** Accepted (superseded in implementation by ADR 027)
- **Date:** 2026-08-25
- **Depends on:** ADR 001, ADR 005, ADR 012
- **See also:** ADR 027

---

## Decision

Xero is a **company Business MCP** connector, not an INFRA operational dataset.

INFRA owns:

- reusable catalogue definition (`conn_xero`)
- OAuth orchestration and encrypted token storage (ADR 027)
- tenant identity, permissions, metering, and audit

The company Business MCP owns live accounting reads. INFRA must not become a duplicate Xero warehouse.

Phase one is **read only**. Writes remain `financial_action` and require permission + future approval (ADR 005). Do not enable invoice creation, payments, journals, bank-transaction writes, or payroll modifications.

Caddington is the first production tenant. No Caddington-specific React routes.
