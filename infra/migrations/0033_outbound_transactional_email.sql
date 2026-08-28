-- Outbound transactional email: company-scoped sender configuration and delivery metadata

CREATE TABLE IF NOT EXISTS company_email_config (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL UNIQUE REFERENCES companies(id),
  provider TEXT NOT NULL DEFAULT 'microsoft365',
  sender_address TEXT NOT NULL,
  sender_display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  allowed_types_json TEXT NOT NULL DEFAULT '[]',
  health_status TEXT NOT NULL DEFAULT 'configuration_required',
  last_sent_at TEXT,
  last_error_category TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_company_email_config_company
  ON company_email_config(company_id);

ALTER TABLE email_outbox ADD COLUMN from_email TEXT;
ALTER TABLE email_outbox ADD COLUMN email_type TEXT;
ALTER TABLE email_outbox ADD COLUMN failure_category TEXT;
ALTER TABLE email_outbox ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS email_rate_limits (
  scope_key TEXT NOT NULL,
  window_start TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope_key, window_start)
);

-- Caddington Holdings pilot configuration (Mail.Send permission required before sends succeed)
INSERT OR IGNORE INTO company_email_config (
  id, company_id, provider, sender_address, sender_display_name, enabled,
  allowed_types_json, health_status, created_at, updated_at
) VALUES (
  'cec_caddington',
  'co_caddington',
  'microsoft365',
  'admin@CaddingtonHoldings.co.uk',
  'Caddington Holdings',
  1,
  '["PASSWORD_RESET","USER_INVITATION","TEST_EMAIL"]',
  'permission_required',
  datetime('now'),
  datetime('now')
);
