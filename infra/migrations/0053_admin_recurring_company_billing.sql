-- Admin recurring company billing: Stripe subscription mappings for blanket SaaS fees.

CREATE TABLE IF NOT EXISTS company_recurring_charges (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  stripe_subscription_id TEXT UNIQUE,
  stripe_product_id TEXT,
  stripe_price_id TEXT,
  stripe_customer_id TEXT,
  stripe_payment_method_id TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GBP',
  interval TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'creating',
  failure_reason TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  canceled_by TEXT,
  canceled_at TEXT,
  last_invoice_id TEXT,
  last_invoice_status TEXT,
  last_invoice_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_company_recurring_charges_company
  ON company_recurring_charges(company_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_company_recurring_charges_subscription
  ON company_recurring_charges(stripe_subscription_id);
