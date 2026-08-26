# ADR 006 — Three-level metering model

- **Status:** Accepted
- **Date:** 2026-08-25
- **Depends on:** ADR 002, ADR 003, ADR 004
- **Applies to:** usage, interactions, pricing, Usage / Billing UX

---

## Context

One human ChatGPT question can call several metered tools. Showing each 1p line as a separate customer charge is technically correct and commercially confusing.

We also need room for future operations such as “raise an invoice” that contain permission checks, lookups, writes, external API calls, and audit events — not all of which should be customer-billable.

---

## Decision

INFRA meters three levels. Granular rows are never discarded.

```
INTERACTION          one human / AI turn when correlation is defensible
    ↓
REQUEST / TOOL CALL  one gateway operation (usage_records + ledger debit)
    ↓
COST COMPONENT       optional provider cost lines (schema ready; amounts may be unknown)
```

Rules:

1. The **ledger** remains authoritative at the tool-call level. An interaction costing 2p is still two 1p `usage_debit` rows.
2. Customer presentation may aggregate only when `interaction_id` is shared.
3. Internal steps (authz, health, discovery, audit) are not separately customer-billable unless a pricing rule says so.
4. Provider cost components stay `unknown` until real quantities exist. Missing cost is **not** stored or shown as £0.
5. TEST prices stay Knowledge Search 1p and Knowledge Read 1p. The 60% commercial margin remains banked (ADR 003).

---

## Consequences

- Migration `0010` adds `interactions` and `usage_cost_components`.
- Usage UX defaults to interaction cards. Admin may still list operations.
- Billing UX may show an interaction total with expandable operation lines; the ledger table is unchanged.
