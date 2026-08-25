-- Request grouping foundation + explicit margin-basis vocabulary.
-- Does NOT change current TEST 1p customer charges.
-- Does NOT backfill historical usage into guessed interaction groups.

ALTER TABLE usage_records ADD COLUMN interaction_id TEXT;
ALTER TABLE usage_records ADD COLUMN parent_request_id TEXT;
ALTER TABLE usage_records ADD COLUMN mcp_session_id TEXT;

ALTER TABLE gateway_requests ADD COLUMN interaction_id TEXT;
ALTER TABLE gateway_requests ADD COLUMN parent_request_id TEXT;
ALTER TABLE gateway_requests ADD COLUMN mcp_session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_usage_interaction
  ON usage_records(company_id, interaction_id, recorded_at);

CREATE INDEX IF NOT EXISTS idx_gateway_interaction
  ON gateway_requests(company_id, interaction_id, created_at);

-- Explicit commercial vocabulary:
--   gross_margin     charge = cost / (1 - margin)     e.g. 60% GM → cost / 0.40
--   markup_on_cost   charge = cost * (1 + markup)     e.g. 60% markup → cost * 1.60
-- These are NOT the same. Current TEST rules remain fixed 1p and do not use either.
ALTER TABLE pricing_policies ADD COLUMN margin_basis TEXT NOT NULL DEFAULT 'gross_margin';
ALTER TABLE pricing_rules ADD COLUMN margin_basis TEXT NOT NULL DEFAULT 'gross_margin';
ALTER TABLE pricing_rules ADD COLUMN cost_category TEXT;

-- Future write/approval classification (schema only — enforcement stays off)
CREATE TABLE IF NOT EXISTS action_classifications (
  action TEXT PRIMARY KEY,
  class TEXT NOT NULL,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  customer_label TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO action_classifications
  (action, class, requires_approval, customer_label, notes, created_at)
VALUES
  ('knowledge.search', 'read', 0, 'Knowledge search', 'Customer-facing search of company knowledge.', datetime('now')),
  ('knowledge.read', 'read', 0, 'Knowledge read', 'Read a specific knowledge document.', datetime('now')),
  ('system.health', 'system', 0, 'Connection check', 'Non-billable health / discovery.', datetime('now')),
  ('mcp.query_business_data', 'read', 0, 'Business data query', 'Structured warehouse read.', datetime('now')),
  ('financial.invoice.create', 'financial_action', 1, 'Raise invoice', 'Future — not enabled.', datetime('now')),
  ('financial.po.create', 'financial_action', 1, 'Raise purchase order', 'Future — not enabled.', datetime('now')),
  ('ops.engineer.book', 'write', 1, 'Book engineer', 'Future — not enabled.', datetime('now')),
  ('ops.quote.send', 'external_send', 1, 'Send quote', 'Future — not enabled.', datetime('now')),
  ('data.delete', 'delete', 1, 'Delete records', 'Future — not enabled.', datetime('now')),
  ('data.batch_update', 'batch_write', 1, 'Batch update', 'Future — not enabled.', datetime('now'));
