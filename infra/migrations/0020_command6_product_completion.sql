-- Command 6: payment methods, auto top-up, notifications, teams, invitations, billing docs, addons, email outbox

-- Payment method details on provider account
ALTER TABLE payment_provider_accounts ADD COLUMN payment_method_id TEXT;
ALTER TABLE payment_provider_accounts ADD COLUMN payment_method_brand TEXT;
ALTER TABLE payment_provider_accounts ADD COLUMN payment_method_last4 TEXT;
ALTER TABLE payment_provider_accounts ADD COLUMN payment_method_exp_month INTEGER;
ALTER TABLE payment_provider_accounts ADD COLUMN payment_method_exp_year INTEGER;
ALTER TABLE payment_provider_accounts ADD COLUMN payment_method_status TEXT DEFAULT 'none';

-- Track Stripe setup checkout sessions
CREATE TABLE IF NOT EXISTS stripe_setup_sessions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  stripe_session_id TEXT UNIQUE,
  stripe_setup_intent_id TEXT,
  status TEXT NOT NULL DEFAULT 'created',
  created_by TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  failure_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_stripe_setup_sessions_company
  ON stripe_setup_sessions(company_id, created_at DESC);

-- Auto top-up transaction ledger (idempotency + audit)
CREATE TABLE IF NOT EXISTS auto_top_up_transactions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  idempotency_key TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GBP',
  status TEXT NOT NULL DEFAULT 'pending',
  stripe_payment_intent_id TEXT,
  stripe_event_id TEXT,
  ledger_entry_id TEXT,
  failure_reason TEXT,
  trigger_balance_cents INTEGER,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(company_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_auto_topup_company_status
  ON auto_top_up_transactions(company_id, status, created_at DESC);

-- Auto top-up monthly cap tracking
ALTER TABLE company_commercial_settings ADD COLUMN auto_top_up_monthly_cap_cents INTEGER;
ALTER TABLE company_commercial_settings ADD COLUMN auto_top_up_monthly_spent_cents INTEGER DEFAULT 0;
ALTER TABLE company_commercial_settings ADD COLUMN auto_top_up_month_key TEXT;

-- Notifications (in-app)
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  user_id TEXT,
  notification_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  href TEXT,
  dedup_key TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_company_user
  ON notifications(company_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_dedup
  ON notifications(company_id, dedup_key, created_at DESC);

-- Teams
CREATE TABLE IF NOT EXISTS company_teams (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  description TEXT,
  default_role TEXT NOT NULL DEFAULT 'office_staff',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE(company_id, name)
);
CREATE INDEX IF NOT EXISTS idx_company_teams_company
  ON company_teams(company_id, status);

CREATE TABLE IF NOT EXISTS company_team_members (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES company_teams(id),
  user_id TEXT NOT NULL,
  role TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(team_id, user_id)
);

-- Custom roles (company-owned)
CREATE TABLE IF NOT EXISTS company_custom_roles (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  cloned_from TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE(company_id, slug)
);

CREATE TABLE IF NOT EXISTS company_custom_role_grants (
  id TEXT PRIMARY KEY,
  custom_role_id TEXT NOT NULL REFERENCES company_custom_roles(id),
  action TEXT NOT NULL,
  effect TEXT NOT NULL,
  UNIQUE(custom_role_id, action)
);

-- Pending invitations with lifecycle
CREATE TABLE IF NOT EXISTS user_invitations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  team_id TEXT,
  custom_role_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  invited_by TEXT NOT NULL,
  setup_token_id TEXT,
  sent_at TEXT,
  expires_at TEXT NOT NULL,
  cancelled_at TEXT,
  accepted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_invitations_company
  ON user_invitations(company_id, status, created_at DESC);

-- Billing documents (Xero invoice references — not INFRA-generated invoices)
CREATE TABLE IF NOT EXISTS billing_documents (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  document_type TEXT NOT NULL DEFAULT 'xero_invoice',
  external_ref TEXT,
  invoice_number TEXT,
  issue_date TEXT,
  amount_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'GBP',
  status TEXT NOT NULL DEFAULT 'draft',
  period_start TEXT,
  period_end TEXT,
  pdf_url TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_billing_documents_company
  ON billing_documents(company_id, issue_date DESC);

-- Add-on catalog
CREATE TABLE IF NOT EXISTS addon_catalog (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  monthly_price_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS company_addon_subscriptions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  addon_id TEXT NOT NULL REFERENCES addon_catalog(id),
  status TEXT NOT NULL DEFAULT 'requested',
  activated_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(company_id, addon_id)
);

-- Email outbox (provider abstraction)
CREATE TABLE IF NOT EXISTS email_outbox (
  id TEXT PRIMARY KEY,
  company_id TEXT,
  to_email TEXT NOT NULL,
  template_key TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  body_html TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  provider TEXT,
  provider_message_id TEXT,
  error_message TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_outbox_status
  ON email_outbox(status, created_at DESC);

-- Promotional credit grants with optional expiry
CREATE TABLE IF NOT EXISTS promotional_credit_grants (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  ledger_entry_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  remaining_cents INTEGER NOT NULL,
  reason TEXT NOT NULL,
  internal_note TEXT,
  granted_by TEXT NOT NULL,
  expires_at TEXT,
  expired_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_promo_grants_company
  ON promotional_credit_grants(company_id, remaining_cents);

-- Optional team on membership
ALTER TABLE company_memberships ADD COLUMN team_id TEXT;
ALTER TABLE company_memberships ADD COLUMN custom_role_id TEXT;
