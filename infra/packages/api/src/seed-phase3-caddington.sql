-- Phase 3 production activation for Caddington (safe to re-run)

-- Ensure credit balance row exists for Caddington
INSERT OR IGNORE INTO credit_balances (company_id, balance_cents, currency, updated_at)
VALUES ('co_caddington', 0, 'GBP', datetime('now'));

UPDATE credit_balances
SET low_balance_threshold_cents = 500,
    updated_at = datetime('now')
WHERE company_id = 'co_caddington';

-- Opening promotional credit (test) — only if no ledger entries yet
INSERT OR IGNORE INTO ledger_entries (
  id, company_id, entry_type, amount_cents, currency, balance_after_cents,
  reference_type, reference_id, description, metadata_json, created_by, created_at
) VALUES (
  'ledger_cad_opening',
  'co_caddington',
  'promotional_credit',
  1000,
  'GBP',
  1000,
  'seed',
  'phase3_opening_credit',
  'Phase 3 test promotional credit (£10.00) — not commercial pricing',
  '{"isTestConfig":true,"phase":3}',
  'infra-system',
  datetime('now')
);

UPDATE credit_balances
SET balance_cents = (
  SELECT COALESCE(SUM(amount_cents), 0) FROM ledger_entries WHERE company_id = 'co_caddington'
),
updated_at = datetime('now')
WHERE company_id = 'co_caddington';

-- Test pricing (clearly labelled) — platform defaults (company_id NULL)
INSERT OR IGNORE INTO pricing_rules (
  id, company_id, action, pricing_mode, fixed_charge_cents, markup_percent,
  minimum_charge_cents, charge_on_failure, is_billable, label, is_test_config, enabled,
  created_at, updated_at
) VALUES
  ('price_knowledge_search', NULL, 'knowledge.search', 'fixed', 1, NULL, 0, 0, 1,
   'TEST: knowledge.search = 1p per successful request', 1, 1, datetime('now'), datetime('now')),
  ('price_knowledge_read', NULL, 'knowledge.read', 'fixed', 1, NULL, 0, 0, 1,
   'TEST: knowledge.read = 1p per successful request', 1, 1, datetime('now'), datetime('now')),
  ('price_system_health', NULL, 'system.health', 'fixed', 0, NULL, 0, 0, 0,
   'TEST: system.health non-billable', 1, 1, datetime('now'), datetime('now'));

-- Map Caddington MCP tools → INFRA actions
INSERT OR IGNORE INTO mcp_tool_action_map
  (id, mcp_environment_id, tool_name, action, risk_class, created_at)
VALUES
  ('map_cad_search', 'mcp_caddington_primary', 'search_company_knowledge', 'knowledge.search', 'low_risk', datetime('now')),
  ('map_cad_getdoc', 'mcp_caddington_primary', 'get_knowledge_document', 'knowledge.read', 'low_risk', datetime('now')),
  ('map_cad_health', 'mcp_caddington_primary', 'system_health', 'system.health', 'low_risk', datetime('now')),
  ('map_cad_summary', 'mcp_caddington_primary', 'database_summary', 'knowledge.read', 'low_risk', datetime('now'));

-- AI client connection shells for Caddington
INSERT OR IGNORE INTO ai_client_connections
  (id, company_id, client_type, display_name, status, gateway_path, setup_notes, created_at, updated_at)
VALUES
  ('ai_cad_chatgpt', 'co_caddington', 'chatgpt', 'ChatGPT', 'ready_to_connect',
   '/api/gateway/v1/execute',
   'Generate a service identity token, then configure ChatGPT Custom GPT / Actions to call the INFRA gateway endpoint with the Bearer token. Do not point ChatGPT directly at Caddington MCP.',
   datetime('now'), datetime('now')),
  ('ai_cad_claude', 'co_caddington', 'claude', 'Claude', 'ready_to_connect',
   '/api/gateway/v1/execute',
   'Generate a service identity token, then configure Claude to call the INFRA gateway with the Bearer token.',
   datetime('now'), datetime('now')),
  ('ai_cad_whatsapp', 'co_caddington', 'whatsapp', 'WhatsApp', 'coming_soon',
   NULL, 'WhatsApp channel gateway is planned for a later phase.', datetime('now'), datetime('now'));

INSERT OR IGNORE INTO audit_events
  (id, company_id, event_type, actor, resource_type, resource_id, detail_json, created_at)
VALUES (
  'audit_phase3_activate',
  'co_caddington',
  'company.updated',
  'infra-system',
  'company',
  'co_caddington',
  '{"phase":3,"gateway":true,"ledger":true,"stripeFoundation":true}',
  datetime('now')
);
