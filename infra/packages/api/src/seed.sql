-- Registry seed data for INFRA Phase 1
-- No fake operational business records. Caddington becomes first live tenant after deployment.

INSERT OR REPLACE INTO companies (id, slug, name, status, primary_domain, notes, created_at, updated_at) VALUES
  ('co_caddington', 'caddington-holdings', 'Caddington Holdings', 'active', NULL, 'First live test tenant. Existing Caddington MCP remains a separate external service.', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('co_ht', 'ht-business', 'HT Business', 'active', NULL, 'Future primary connector: Commusoft. Not connected in Phase 1.', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('co_el', 'el-business', 'EL Business', 'active', NULL, 'Future primary connector: BigChange. Not connected in Phase 1.', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

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
  'External MCP environment metadata. Managed separately from INFRA.',
  'https://caddington-mcp.example/mcp',
  'sse',
  'registered',
  1,
  1,
  'dp_caddington_knowledge',
  NULL,
  NULL,
  '["search","read"]',
  'secret_ref_caddington_mcp_auth',
  NULL,
  NULL,
  'Awaiting first authenticated health check',
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z'
);

INSERT OR REPLACE INTO connector_instances (
  id, company_id, connector_definition_id, name, status, config_json, sync_settings_json,
  data_environment_id, last_sync_at, last_sync_status, last_sync_message,
  health_status, health_message, created_at, updated_at
) VALUES
  (
    'ci_caddington_gdrive',
    'co_caddington',
    'conn_google_drive',
    'Caddington Google Drive',
    'configured',
    '{"note":"Registry metadata only in Phase 1"}',
    '{"enabled":false,"mode":"manual","schedule":null}',
    NULL,
    NULL,
    NULL,
    'Not connected in Phase 1',
    'unknown',
    'Registry entry only',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z'
  ),
  (
    'ci_ht_commusoft',
    'co_ht',
    'conn_commusoft',
    'HT Commusoft',
    'draft',
    '{}',
    '{"enabled":false,"mode":"manual","schedule":null}',
    NULL,
    NULL,
    NULL,
    'Not connected in Phase 1',
    'unknown',
    'Awaiting credentials and live system connection',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z'
  ),
  (
    'ci_el_bigchange',
    'co_el',
    'conn_bigchange',
    'EL BigChange',
    'draft',
    '{}',
    '{"enabled":false,"mode":"manual","schedule":null}',
    NULL,
    NULL,
    NULL,
    'Not connected in Phase 1',
    'unknown',
    'Awaiting credentials and live system connection',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z'
  );

INSERT OR REPLACE INTO audit_events (id, company_id, event_type, actor, resource_type, resource_id, detail_json, created_at) VALUES
  ('audit_seed_1', 'co_caddington', 'mcp.registered', 'infra-system', 'mcp', 'mcp_caddington_primary', '{"name":"Caddington MCP","isExternal":true}', '2026-01-01T00:00:00.000Z'),
  ('audit_seed_2', 'co_caddington', 'connector.instance_created', 'infra-system', 'connector', 'ci_caddington_gdrive', '{"connector":"google-drive","status":"configured"}', '2026-01-01T00:00:00.000Z'),
  ('audit_seed_3', 'co_ht', 'company.created', 'infra-system', 'company', 'co_ht', '{"name":"HT Business"}', '2026-01-01T00:00:00.000Z'),
  ('audit_seed_4', 'co_el', 'company.created', 'infra-system', 'company', 'co_el', '{"name":"EL Business"}', '2026-01-01T00:00:00.000Z');
