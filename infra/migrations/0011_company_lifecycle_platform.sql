-- Additive company lifecycle, wallet credit class, and payment-provider foundation.
-- Safe to apply on production. Does not rewrite existing tenant rows except COALESCE fills.

ALTER TABLE companies ADD COLUMN currency TEXT;
ALTER TABLE companies ADD COLUMN billing_mode TEXT;
ALTER TABLE companies ADD COLUMN mcp_onboarding_status TEXT;
ALTER TABLE companies ADD COLUMN primary_admin_user_id TEXT;
ALTER TABLE companies ADD COLUMN branding_json TEXT;
ALTER TABLE companies ADD COLUMN config_json TEXT;
ALTER TABLE companies ADD COLUMN archived_at TEXT;

UPDATE companies
SET
  currency = COALESCE(currency, 'GBP'),
  billing_mode = COALESCE(billing_mode, 'test'),
  mcp_onboarding_status = COALESCE(mcp_onboarding_status, 'not_provisioned'),
  branding_json = COALESCE(branding_json, '{}'),
  config_json = COALESCE(config_json, '{}'),
  updated_at = updated_at
WHERE currency IS NULL
   OR billing_mode IS NULL
   OR mcp_onboarding_status IS NULL
   OR branding_json IS NULL
   OR config_json IS NULL;

-- Existing production tenants remain active. New companies use onboarding.
UPDATE companies
SET mcp_onboarding_status = 'registered'
WHERE id IN ('co_caddington', 'co_ht', 'co_el')
  AND mcp_onboarding_status = 'not_provisioned';

CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status);
CREATE INDEX IF NOT EXISTS idx_companies_name ON companies(name);
CREATE INDEX IF NOT EXISTS idx_companies_updated ON companies(updated_at);

CREATE TABLE IF NOT EXISTS payment_provider_accounts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_configured',
  external_customer_ref TEXT,
  auto_top_up_enabled INTEGER NOT NULL DEFAULT 0,
  auto_top_up_threshold_cents INTEGER,
  auto_top_up_amount_cents INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(company_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_payment_provider_accounts_company
  ON payment_provider_accounts(company_id);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_company_created
  ON ledger_entries(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_records_company_recorded
  ON usage_records(company_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_service_identities_company_status
  ON service_identities(company_id, status);
