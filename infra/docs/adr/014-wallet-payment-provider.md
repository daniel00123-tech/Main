# ADR 014 — Wallet and payment-provider separation

- **Status:** Accepted
- **Date:** 2026-08-25
- **Depends on:** ADR 004

---

## Decision

The ledger is provider-agnostic. Stripe is `provider = stripe`, not the wallet itself.

Credit classes:

| Class | Typical source | Label |
| --- | --- | --- |
| `test` | `promotional_credit`, opening grant, admin TEST adjustment | TEST CREDIT |
| `paid` | Stripe `top_up` | PAID CREDIT |

Every mutation has a ledger row. Opening grants for new companies are TEST credit.

Money flow (future, not live):

Customer → Stripe → INFRA wallet → usage

Separately: Stripe → payout → Tide business bank account.

INFRA does **not** need a Tide API for v1.

Planned top-ups: £10 / £25 / £50 / £100 / custom. Auto top-up example: balance < £5 → add £25. Not enabled until Stripe credentials and owner approval exist.

UI must say **Online payments not configured** when Stripe secrets are absent. No fake charge buttons.
