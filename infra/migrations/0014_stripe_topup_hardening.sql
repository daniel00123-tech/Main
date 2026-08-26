-- Stripe top-up lifecycle hardening (additive).
-- Extends checkout session tracking for tenant binding, refunds, and reconciliation.

ALTER TABLE stripe_checkout_sessions ADD COLUMN stripe_payment_intent_id TEXT;
ALTER TABLE stripe_checkout_sessions ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE stripe_checkout_sessions ADD COLUMN stripe_mode TEXT;
ALTER TABLE stripe_checkout_sessions ADD COLUMN credited_at TEXT;
ALTER TABLE stripe_checkout_sessions ADD COLUMN failure_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_stripe_checkout_status
  ON stripe_checkout_sessions(company_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stripe_checkout_payment_intent
  ON stripe_checkout_sessions(stripe_payment_intent_id);

-- Normalise legacy status values to explicit lifecycle names.
UPDATE stripe_checkout_sessions SET status = 'checkout_created' WHERE status = 'open';
UPDATE stripe_checkout_sessions SET status = 'credited' WHERE status = 'completed';
