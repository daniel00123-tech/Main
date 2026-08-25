# ADR 004 — Wallet ledger and Stripe preparation

- **Status:** Accepted
- **Date:** 2026-08-24
- **Depends on:** ADR 001, ADR 003
- **Applies to:** ledger, wallets, Stripe checkout (not live)

---

## Context

Customer prepaid credit is the commercial control. Stripe is the intended card processor. Card details must never touch INFRA.

---

## Decision — ledger

The **ledger is authoritative**. `credit_balances.balance_cents` is a cache healed from `SUM(ledger_entries.amount_cents)`.

| Rule | Behaviour |
| --- | --- |
| Credits | `top_up`, `manual_credit`, `promotional_credit`, `refund` |
| Debits | `usage_debit` (negative amount) |
| Idempotency | Unique `(company_id, reference_type, reference_id)` |
| Overdraft | `usage_debit` that would make the sum negative throws `INSUFFICIENT_CREDIT` |
| Concurrency | Pre-check wallet, then insert; unique reference prevents double debit |
| Webhooks | `stripe_webhook_events.stripe_event_id` unique; replay is a no-op |

Refunds / reversals are new ledger rows (`refund` / `adjustment`), never silent mutations of an existing debit.

---

## Decision — Stripe (prepared, not live)

Planned top-ups: **£10 / £25 / £50 / £100** plus custom (≥ £5). Later: auto top-up when balance falls below a threshold (example: below £5 add £25).

Architecture already sketched:

- Stripe Checkout (or Payment Element later)
- Success / cancel URLs: `/portal/{companySlug}/billing?topup=…`
- Webhook handler with idempotency
- Wallet credit only after verified `checkout.session.completed`
- Store Stripe customer / session / payment-method **references**, never PAN/CVC

Until `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` exist **and** an owner approves go-live, the UI must say card payments are **not live**.

---

## Secrets required to enable Stripe later (names only)

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PUBLISHABLE_KEY` (frontend, when Payment Element is added)
