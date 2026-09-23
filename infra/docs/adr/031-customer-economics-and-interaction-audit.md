# ADR 031 — Customer economics and interaction audit

- **Status:** Accepted
- **Date:** 2026-08-29
- **Depends on:** ADR 003, ADR 006, ADR 013, ADR 016

---

## Decision

Reuse `usage_records`, `ledger_entries`, and `interactions` for customer economics. Do not create a second cost ledger.

Distinguish:

1. Direct attributable cost (only when measured or explicitly estimated)
2. Platform overheads (manual, not allocated to tenants in V1)

Recognised revenue for margin is wallet usage charges. Cash collected is shown separately.

Conversation inspection is a super-admin adapter over existing interaction/usage/gateway rows, with access logging and payload redaction.

Quality auditing is asynchronous, sampled, and proposal-only.
