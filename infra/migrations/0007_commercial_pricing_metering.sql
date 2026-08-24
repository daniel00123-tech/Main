-- Phase 4: commercial pricing, cost registry, metering integrity

-- Idempotent request identity on usage
ALTER TABLE usage_records ADD COLUMN request_id TEXT;
ALTER TABLE usage_records ADD COLUMN cost_basis TEXT; -- actual | estimated | unknown
ALTER TABLE usage_records ADD COLUMN estimated_cost_micros INTEGER;
ALTER TABLE usage_records ADD COLUMN underlying_cost_micros INTEGER;
ALTER TABLE usage_records ADD COLUMN pricing_rule_id TEXT;
ALTER TABLE usage_records ADD COLUMN rate_card_id TEXT;
ALTER TABLE usage_records ADD COLUMN rate_card_version TEXT;
ALTER TABLE usage_records ADD COLUMN target_margin_bps INTEGER;
ALTER TABLE usage_records ADD COLUMN calculated_selling_cents INTEGER;
ALTER TABLE usage_records ADD COLUMN minimum_charge_applied INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_records ADD COLUMN gross_profit_cents INTEGER;
ALTER TABLE usage_records ADD COLUMN actual_margin_bps INTEGER;
ALTER TABLE usage_records ADD COLUMN ledger_entry_id TEXT;
ALTER TABLE usage_records ADD COLUMN settlement_status TEXT NOT NULL DEFAULT 'unsettled';
-- unsettled | settled | zero_charge | failed | reconciliation_hold

CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_request_id
  ON usage_records(request_id) WHERE request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_correlation_id
  ON usage_records(correlation_id) WHERE correlation_id IS NOT NULL;

-- Gateway client request idempotency
ALTER TABLE gateway_requests ADD COLUMN client_request_id TEXT;
ALTER TABLE gateway_requests ADD COLUMN request_id TEXT;
ALTER TABLE gateway_requests ADD COLUMN settlement_status TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_gateway_client_request
  ON gateway_requests(company_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_gateway_request_id
  ON gateway_requests(request_id) WHERE request_id IS NOT NULL;

-- Commercial policy (platform defaults + optional company overrides)
CREATE TABLE IF NOT EXISTS pricing_policies (
  id TEXT PRIMARY KEY,
  company_id TEXT REFERENCES companies(id),
  target_margin_bps INTEGER NOT NULL DEFAULT 6000, -- 60.00%
  minimum_charge_cents INTEGER NOT NULL DEFAULT 1,
  currency TEXT NOT NULL DEFAULT 'GBP',
  is_test_config INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  label TEXT,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pricing_policies_company
  ON pricing_policies(company_id, enabled);

-- Versioned provider rate cards
CREATE TABLE IF NOT EXISTS provider_rate_cards (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL, -- cloudflare | openai | anthropic | other
  version_label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', -- draft | proposed | active | superseded
  currency TEXT NOT NULL DEFAULT 'GBP',
  source_url TEXT,
  source_notes TEXT,
  verified_at TEXT,
  effective_from TEXT,
  effective_to TEXT,
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, version_label)
);

CREATE TABLE IF NOT EXISTS provider_rate_items (
  id TEXT PRIMARY KEY,
  rate_card_id TEXT NOT NULL REFERENCES provider_rate_cards(id),
  service TEXT NOT NULL,
  sku TEXT,
  billing_unit TEXT NOT NULL, -- requests | cpu_ms | rows_read | tokens_in | tokens_out | ...
  unit_cost_micros INTEGER NOT NULL, -- millionths of currency unit
  included_allowance REAL,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_provider_rate_items_card
  ON provider_rate_items(rate_card_id);

-- Monthly pricing review proposals (never auto-apply)
CREATE TABLE IF NOT EXISTS provider_pricing_reviews (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | superseded
  current_rate_card_id TEXT REFERENCES provider_rate_cards(id),
  proposed_rate_card_id TEXT REFERENCES provider_rate_cards(id),
  source_url TEXT,
  source_snapshot TEXT,
  diff_json TEXT NOT NULL DEFAULT '{}',
  detected_at TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_notes TEXT,
  created_at TEXT NOT NULL
);

-- Extend pricing_rules for commercial modes (keep existing columns)
ALTER TABLE pricing_rules ADD COLUMN target_margin_bps INTEGER;
ALTER TABLE pricing_rules ADD COLUMN rate_card_id TEXT;
ALTER TABLE pricing_rules ADD COLUMN version_label TEXT;
ALTER TABLE pricing_rules ADD COLUMN effective_from TEXT;
ALTER TABLE pricing_rules ADD COLUMN effective_to TEXT;

-- Financial integrity exceptions (never silently rewrite ledger)
CREATE TABLE IF NOT EXISTS financial_integrity_exceptions (
  id TEXT PRIMARY KEY,
  company_id TEXT REFERENCES companies(id),
  exception_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  status TEXT NOT NULL DEFAULT 'open', -- open | acknowledged | resolved | ignored
  usage_record_id TEXT,
  ledger_entry_id TEXT,
  gateway_request_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_financial_exceptions_status
  ON financial_integrity_exceptions(status, detected_at);
