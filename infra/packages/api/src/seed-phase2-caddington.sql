-- Phase 2 production activation for Caddington Holdings
-- Safe to re-run: uses INSERT OR IGNORE / targeted UPDATEs

-- Point MCP auth at Worker secret binding name (credential never stored in D1)
UPDATE mcp_environments
SET auth_secret_ref = 'CADDINGTON_MCP_AUTH_TOKEN',
    service_binding_ref = 'CADDINGTON_MCP',
    updated_at = datetime('now')
WHERE id = 'mcp_caddington_primary';

-- Read-only tool allowlist for registered Caddington MCP
INSERT OR IGNORE INTO mcp_tool_allowlist
  (id, company_id, mcp_environment_id, tool_name, risk_class, enabled, created_at, updated_at)
VALUES
  ('allow_cad_search', 'co_caddington', 'mcp_caddington_primary', 'search_company_knowledge', 'low_risk', 1, datetime('now'), datetime('now')),
  ('allow_cad_health', 'co_caddington', 'mcp_caddington_primary', 'system_health', 'low_risk', 1, datetime('now'), datetime('now')),
  ('allow_cad_summary', 'co_caddington', 'mcp_caddington_primary', 'database_summary', 'low_risk', 1, datetime('now'), datetime('now')),
  ('allow_cad_getdoc', 'co_caddington', 'mcp_caddington_primary', 'get_knowledge_document', 'low_risk', 1, datetime('now'), datetime('now'));

-- Grant platform administrator a Caddington company membership (Company Admin)
-- Does not remove is_platform_admin; membership enables company portal access.
INSERT OR IGNORE INTO company_memberships
  (id, user_id, company_id, role, status, created_at, updated_at)
SELECT
  'mem_platform_caddington',
  id,
  'co_caddington',
  'company_admin',
  'active',
  datetime('now'),
  datetime('now')
FROM users
WHERE is_platform_admin = 1
  AND status = 'active'
LIMIT 1;

-- Reflect that Google Drive knowledge is operated via external Caddington MCP
UPDATE connector_instances
SET status = 'healthy',
    health_status = 'healthy',
    health_message = 'Knowledge available via Caddington MCP (external sync)',
    last_sync_message = 'Synced by external Caddington MCP — not managed by INFRA connectors yet',
    updated_at = datetime('now')
WHERE id = 'ci_caddington_gdrive';

INSERT OR IGNORE INTO audit_events (id, company_id, event_type, actor, resource_type, resource_id, detail_json, created_at)
VALUES (
  'audit_phase2_activate',
  'co_caddington',
  'mcp.updated',
  'infra-system',
  'mcp',
  'mcp_caddington_primary',
  '{"phase":2,"authSecretRef":"CADDINGTON_MCP_AUTH_TOKEN","serviceBindingRef":"CADDINGTON_MCP","allowlistSeeded":true}',
  datetime('now')
);
