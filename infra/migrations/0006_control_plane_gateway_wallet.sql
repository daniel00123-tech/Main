-- Phase 3: multi-tenant control plane — gateway, wallet ledger, service identities, Stripe foundation

-- Users: last login tracking
ALTER TABLE users ADD COLUMN last_login_at TEXT;

-- Service identities: type, token hash (never plaintext), usage counters
ALTER TABLE service_identities ADD COLUMN identity_type TEXT NOT NULL DEFAULT 'ai_client';
ALTER TABLE service_identities ADD COLUMN token_hash TEXT;
ALTER TABLE service_identities ADD COLUMN token_prefix TEXT;
ALTER TABLE service_identities ADD COLUMN last_used_at TEXT;
ALTER TABLE service_identities ADD COLUMN request_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE service_identities ADD COLUMN scopes_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE service_identities ADD COLUMN mcp_environment_id TEXT REFERENCES mcp_environments(id);

CREATE INDEX IF NOT EXISTS idx_service_identities_token_prefix
  ON service_identities(token_prefix);

-- Append-only wallet ledger (balance reconcilable from entries)
CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  entry_type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GBP',
  balance_after_cents INTEGER NOT NULL,
  reference_type TEXT,
  reference_id TEXT,
  description TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(company_id, reference_type, reference_id)
);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_company_created
  ON ledger_entries(company_id, created_at);

-- Configurable action pricing (test configuration until commercial rates set)
CREATE TABLE IF NOT EXISTS pricing_rules (
  id TEXT PRIMARY KEY,
  company_id TEXT REFERENCES companies(id),
  action TEXT NOT NULL,
  pricing_mode TEXT NOT NULL DEFAULT 'fixed',
  fixed_charge_cents INTEGER,
  markup_percent REAL,
  minimum_charge_cents INTEGER NOT NULL DEFAULT 0,
  charge_on_failure INTEGER NOT NULL DEFAULT 0,
  is_billable INTEGER NOT NULL DEFAULT 1,
  label TEXT,
  is_test_config INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pricing_rules_lookup
  ON pricing_rules(company_id, action, enabled);

-- Company billing settings
ALTER TABLE credit_balances ADD COLUMN low_balance_threshold_cents INTEGER NOT NULL DEFAULT 500;
ALTER TABLE credit_balances ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE credit_balances ADD COLUMN currency_locked INTEGER NOT NULL DEFAULT 1;

-- Stripe foundation tables (credentials via Worker secrets only)
CREATE TABLE IF NOT EXISTS stripe_checkout_sessions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  stripe_session_id TEXT UNIQUE,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GBP',
  status TEXT NOT NULL DEFAULT 'pending',
  created_by TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_stripe_checkout_company
  ON stripe_checkout_sessions(company_id);

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  id TEXT PRIMARY KEY,
  stripe_event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT
);

-- Gateway request log (correlation across auth → permission → MCP → meter)
CREATE TABLE IF NOT EXISTS gateway_requests (
  id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL UNIQUE,
  company_id TEXT NOT NULL REFERENCES companies(id),
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_label TEXT,
  source_client TEXT,
  mcp_environment_id TEXT,
  tool_name TEXT,
  action TEXT,
  risk_class TEXT,
  status TEXT NOT NULL,
  permission_allowed INTEGER,
  credit_check_passed INTEGER,
  http_status INTEGER,
  latency_ms INTEGER,
  usage_record_id TEXT,
  ledger_entry_id TEXT,
  error_code TEXT,
  error_message TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gateway_requests_company
  ON gateway_requests(company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_gateway_requests_correlation
  ON gateway_requests(correlation_id);

-- Map MCP tools → INFRA actions for permission/pricing
CREATE TABLE IF NOT EXISTS mcp_tool_action_map (
  id TEXT PRIMARY KEY,
  mcp_environment_id TEXT NOT NULL REFERENCES mcp_environments(id),
  tool_name TEXT NOT NULL,
  action TEXT NOT NULL,
  risk_class TEXT NOT NULL DEFAULT 'low_risk',
  created_at TEXT NOT NULL,
  UNIQUE(mcp_environment_id, tool_name)
);

-- AI client connection registry (company-facing connection status)
CREATE TABLE IF NOT EXISTS ai_client_connections (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  client_type TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_connected',
  service_identity_id TEXT REFERENCES service_identities(id),
  gateway_path TEXT,
  setup_notes TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(company_id, client_type)
);

CREATE INDEX IF NOT EXISTS idx_ai_client_connections_company
  ON ai_client_connections(company_id);

-- Approval hooks reserved for future (schema only — no workflow engine)
CREATE TABLE IF NOT EXISTS action_approval_policies (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  action TEXT NOT NULL,
  risk_class TEXT NOT NULL,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  approver_role TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(company_id, action)
);
