# ADR 015 — Auto top-up architecture (not enabled)

- **Status:** Accepted (architecture only)
- **Date:** 2026-08-25
- **Depends on:** ADR 014

---

## Decision

Auto top-up is **designed but not enabled**. No worker, cron, or background charge exists in production.

### Planned rule (example)

When **paid credit balance** falls below **£5**, automatically create a **£25** Stripe Checkout Session (or off-session PaymentIntent once saved payment methods exist).

### Required safeguards before activation

1. Explicit company opt-in (`company_commercial_settings.auto_top_up_enabled` or `payment_provider_accounts.auto_top_up_enabled`)
2. Platform operator approval + live Stripe credentials separate from test acceptance
3. Saved payment method or Stripe Customer with mandate — never store card data in INFRA
4. Rate limiting: at most one auto top-up per company per 24h unless manual override
5. Audit: `topup.auto_triggered`, `checkout.created`, `wallet.credited` / `payment.failed`
6. Fail closed on webhook delay — do not double-charge while a checkout is `pending`
7. Notification to company admins on auto top-up success/failure

### Credit consumption order (recommendation — not yet enforced in gateway)

For future commercial billing, recommend:

1. **TEST credit first** — promotional/opening grants consumed before paid funds
2. **Paid credit second** — Stripe top-ups
3. Usage debits remain granular in the ledger regardless of class

Rationale: customers who purchased credit should not lose paid balance while TEST grants remain; TEST credit is intentionally limited and non-refundable.

**Not implemented in gateway debit logic yet** — document only until commercial go-live.
