-- Multi-tenant company provisioning (logical tenants in shared INFRA infra)
-- Safe to re-run columns via careful IF NOT EXISTS patterns where supported.

-- Extended company / tenant profile
ALTER TABLE companies ADD COLUMN trading_name TEXT;
ALTER TABLE companies ADD COLUMN company_number TEXT;
ALTER TABLE companies ADD COLUMN country TEXT;
ALTER TABLE companies ADD COLUMN timezone TEXT;
ALTER TABLE companies ADD COLUMN primary_contact_name TEXT;
ALTER TABLE companies ADD COLUMN primary_email TEXT;
ALTER TABLE companies ADD COLUMN billing_email TEXT;
ALTER TABLE companies ADD COLUMN telephone TEXT;
ALTER TABLE companies ADD COLUMN logo_url TEXT;
ALTER TABLE companies ADD COLUMN portal_subdomain TEXT;
ALTER TABLE companies ADD COLUMN portal_hostname TEXT;
ALTER TABLE companies ADD COLUMN provisioned_at TEXT;
ALTER TABLE companies ADD COLUMN suspended_at TEXT;
ALTER TABLE companies ADD COLUMN closed_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_portal_subdomain
  ON companies(portal_subdomain) WHERE portal_subdomain IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_portal_hostname
  ON companies(portal_hostname) WHERE portal_hostname IS NOT NULL;

-- Per-tenant module entitlements (catalogue-driven; not hard-coded integrations)
CREATE TABLE IF NOT EXISTS company_modules (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  module_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available',
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(company_id, module_key)
);

CREATE INDEX IF NOT EXISTS idx_company_modules_company
  ON company_modules(company_id);

-- Lightweight commercial settings (overrides platform defaults)
CREATE TABLE IF NOT EXISTS company_commercial_settings (
  company_id TEXT PRIMARY KEY REFERENCES companies(id),
  currency TEXT NOT NULL DEFAULT 'GBP',
  target_gross_margin_percent REAL NOT NULL DEFAULT 60,
  minimum_charge_cents INTEGER NOT NULL DEFAULT 1,
  monthly_platform_fee_cents INTEGER NOT NULL DEFAULT 0,
  included_credit_cents INTEGER NOT NULL DEFAULT 0,
  low_balance_threshold_cents INTEGER NOT NULL DEFAULT 500,
  auto_top_up_enabled INTEGER NOT NULL DEFAULT 0,
  billing_status TEXT NOT NULL DEFAULT 'active',
  pricing_plan TEXT,
  updated_at TEXT NOT NULL
);

-- Attach existing Caddington tenant into multi-tenant portal model (no duplicate)
UPDATE companies
SET
  trading_name = COALESCE(trading_name, name),
  portal_subdomain = COALESCE(portal_subdomain, 'caddington'),
  portal_hostname = COALESCE(portal_hostname, 'caddington.infra-web.pages.dev'),
  country = COALESCE(country, 'GB'),
  timezone = COALESCE(timezone, 'Europe/London'),
  provisioned_at = COALESCE(provisioned_at, created_at),
  status = CASE WHEN status IS NULL OR status = '' THEN 'active' ELSE status END,
  updated_at = datetime('now')
WHERE id = 'co_caddington';

INSERT OR IGNORE INTO company_commercial_settings (
  company_id, currency, target_gross_margin_percent, minimum_charge_cents,
  monthly_platform_fee_cents, included_credit_cents, low_balance_threshold_cents,
  auto_top_up_enabled, billing_status, pricing_plan, updated_at
) VALUES (
  'co_caddington', 'GBP', 60, 1, 0, 0, 500, 0, 'active', 'standard', datetime('now')
);

INSERT OR IGNORE INTO company_modules
  (id, company_id, module_key, status, config_json, created_at, updated_at)
VALUES
  ('mod_cad_knowledge', 'co_caddington', 'knowledge', 'connected', '{}', datetime('now'), datetime('now')),
  ('mod_cad_chatgpt', 'co_caddington', 'chatgpt', 'connected', '{}', datetime('now'), datetime('now')),
  ('mod_cad_claude', 'co_caddington', 'claude', 'available', '{}', datetime('now'), datetime('now')),
  ('mod_cad_whatsapp', 'co_caddington', 'whatsapp', 'available', '{}', datetime('now'), datetime('now'));
