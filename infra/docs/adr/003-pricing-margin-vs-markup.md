# ADR 003 — Pricing: provider cost, customer charge, margin vs markup

- **Status:** Accepted
- **Date:** 2026-08-24
- **Depends on:** ADR 001
- **Applies to:** pricing engine, commercial admin, future rate cards

---

## Context

INFRA must eventually apply a commercial rule such as “60%”. That phrase is ambiguous:

| Vocabulary | Formula | 4p cost becomes |
| --- | --- | --- |
| **60% gross margin** | `charge = cost / (1 − 0.60)` = `cost / 0.40` | **10p** |
| **60% markup on cost** | `charge = cost × (1 + 0.60)` | **6.4p → 7p** (cent ceil) |

These are not the same. The engine must never silently pick one.

Tonight’s live TEST catalogue remains:

- `knowledge.search` = **1p fixed**
- `knowledge.read` = **1p fixed**
- `system.health` = free

Do not change those amounts until commercial pricing is approved.

---

## Decision

Separate three money concepts on every priced operation:

1. **Provider cost** — what INFRA incurs (AI, Workers, Vectorize, storage, external APIs). May be actual, estimated, or unknown. Unknown cost must not be invented.
2. **Customer charge** — what the company wallet is debited.
3. **Margin / markup** — derived, never stored as a substitute for (1) or (2).

`pricing_policies` and `pricing_rules` carry `margin_basis`:

- `gross_margin` (default) — `chargeFromTargetMargin`
- `markup_on_cost` — `chargeFromMarkupOnCost`

Pricing modes already supported: `fixed`, `cost_plus`, `percent_markup`, `target_margin`, `free`.

Cost categories (schema, not live metering): `ai_model`, `workers`, `workers_ai`, `vectorize`, `storage`, `external_api`, `whatsapp`, `other`, or null.

Automatic scraping of provider websites is **banked**. Rate cards are updated only by an approved review.

Company overrides sit on `pricing_rules.company_id`. Global defaults use `company_id IS NULL`.

---

## Consequences

- Commercial 60% rule can be applied later by flipping TEST fixed rules to `target_margin` **and** choosing `margin_basis` explicitly.
- Wallet settlement stays in whole pence. Sub-penny provider costs use micros.
