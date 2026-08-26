-- Production seed: Caddington Holdings only (first live tenant)
-- No HT/EL demo companies. No fake operational business records.

INSERT OR REPLACE INTO companies (id, slug, name, status, primary_domain, notes, created_at, updated_at) VALUES
  ('co_caddington', 'caddington-holdings', 'Caddington Holdings', 'active', NULL, 'First live INFRA tenant. Existing Caddington MCP remains a separate external service.', datetime('now'), datetime('now'));

INSERT OR REPLACE INTO mcp_environments (
  id, company_id, name, description, endpoint_url, transport, status,
  enabled, is_external, data_plane_id, mcp_version, business_mcp_core_version,
  capabilities_json, auth_secret_ref,
  last_health_check_at, last_healthy_at, health_message,
  created_at, updated_at
) VALUES (
  'mcp_caddington_primary',
  'co_caddington',
  'Caddington MCP',
  'Existing external Caddington MCP service. Metadata only — not migrated into INFRA.',
  'https://caddington-mcp.daniel-dwyer123.workers.dev/mcp',
  'sse',
  'registered',
  1,
  1,
  'dp_caddington_knowledge',
  NULL,
  NULL,
  '["search","read"]',
  'CADDINGTON_MCP_AUTH_TOKEN',
  NULL,
  NULL,
  'Awaiting first authenticated health check',
  datetime('now'),
  datetime('now')
);

INSERT OR REPLACE INTO connector_instances (
  id, company_id, connector_definition_id, name, status, config_json, sync_settings_json,
  data_environment_id, last_sync_at, last_sync_status, last_sync_message,
  health_status, health_message, created_at, updated_at
) VALUES (
  'ci_caddington_gdrive',
  'co_caddington',
  'conn_google_drive',
  'Caddington Google Drive',
  'configured',
  '{"note":"Registry metadata only. Managed by external Caddington MCP."}',
  '{"enabled":false,"mode":"manual","schedule":null}',
  NULL,
  NULL,
  NULL,
  'Not connected via INFRA in Phase 1',
  'unknown',
  'Registry entry only',
  datetime('now'),
  datetime('now')
);

INSERT OR REPLACE INTO audit_events (id, company_id, event_type, actor, resource_type, resource_id, detail_json, created_at) VALUES
  ('audit_prod_1', 'co_caddington', 'company.created', 'infra-system', 'company', 'co_caddington', '{"name":"Caddington Holdings","environment":"production"}', datetime('now')),
  ('audit_prod_2', 'co_caddington', 'mcp.registered', 'infra-system', 'mcp', 'mcp_caddington_primary', '{"name":"Caddington MCP","endpoint":"https://caddington-mcp.daniel-dwyer123.workers.dev/mcp","isExternal":true}', datetime('now'));
