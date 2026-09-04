-- EL Business blanket commercial tariff: 3p per genuine customer request.
-- Prospective only. Does not rewrite historical usage or ledger rows.
-- Does not change Caddington, HT, or global TEST tool rules.

CREATE TABLE IF NOT EXISTS el_customer_requests (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  user_id TEXT,
  actor_email TEXT,
  channel TEXT NOT NULL,
  conversation_id TEXT,
  source_client TEXT,
  traffic_class TEXT NOT NULL,
  outcome TEXT,
  settled INTEGER NOT NULL DEFAULT 0,
  charge_cents INTEGER,
  usage_record_id TEXT,
  ledger_entry_id TEXT,
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_el_customer_requests_chatgpt
  ON el_customer_requests(company_id, user_id, conversation_id, channel, last_activity_at);

CREATE INDEX IF NOT EXISTS idx_el_customer_requests_company
  ON el_customer_requests(company_id, created_at);

INSERT OR IGNORE INTO pricing_policies (
  id, company_id, target_margin_bps, minimum_charge_cents, currency,
  is_test_config, enabled, label, effective_from, effective_to, created_at, updated_at
) VALUES (
  'policy_el_customer_request',
  'co_el',
  6000,
  3,
  'GBP',
  0,
  1,
  'EL Business: £0.03 per customer request',
  datetime('now'),
  NULL,
  datetime('now'),
  datetime('now')
);

INSERT OR IGNORE INTO pricing_rules (
  id, company_id, action, pricing_mode, fixed_charge_cents, markup_percent,
  minimum_charge_cents, charge_on_failure, is_billable, label, is_test_config,
  enabled, created_at, updated_at, target_margin_bps, version_label, effective_from
) VALUES (
  'price_el_customer_request',
  'co_el',
  'customer.request',
  'fixed',
  3,
  NULL,
  3,
  1,
  1,
  'EL Business: 3p per genuine customer request',
  0,
  1,
  datetime('now'),
  datetime('now'),
  6000,
  'el-request-v1',
  datetime('now')
);
