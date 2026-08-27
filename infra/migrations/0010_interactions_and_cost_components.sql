-- First-class interactions + optional provider cost components.
-- Does NOT change TEST 1p customer charges.
-- Does NOT backfill or guess historical groups.

CREATE TABLE IF NOT EXISTS interactions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  client_kind TEXT NOT NULL,
  mcp_id TEXT,
  mcp_session_id TEXT,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  currency TEXT NOT NULL DEFAULT 'GBP',
  operation_count INTEGER NOT NULL DEFAULT 0,
  customer_charge_cents INTEGER NOT NULL DEFAULT 0,
  provider_cost_cents INTEGER,
  provider_cost_known INTEGER NOT NULL DEFAULT 0,
  sourced_from TEXT NOT NULL DEFAULT 'generated',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_interactions_company
  ON interactions(company_id, created_at);

-- Future: one operation may have several provider cost lines.
-- amount_micros NULL + cost_basis='unknown' means unavailable, not £0.
CREATE TABLE IF NOT EXISTS usage_cost_components (
  id TEXT PRIMARY KEY,
  usage_record_id TEXT NOT NULL,
  interaction_id TEXT,
  company_id TEXT NOT NULL,
  category TEXT NOT NULL,
  provider TEXT,
  amount_micros INTEGER,
  cost_basis TEXT NOT NULL DEFAULT 'unknown',
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cost_components_usage
  ON usage_cost_components(usage_record_id);

CREATE INDEX IF NOT EXISTS idx_cost_components_interaction
  ON usage_cost_components(interaction_id);
