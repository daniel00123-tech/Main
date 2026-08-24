-- Demo seed data for INFRA v0.1
-- Caddington: reference tenant with external Caddington MCP registered
-- HT Business: placeholder for future Commusoft
-- EL Business: placeholder for future BigChange

INSERT OR REPLACE INTO companies (id, slug, name, status, primary_domain, notes, created_at, updated_at) VALUES
  ('co_caddington', 'caddington-holdings', 'Caddington Holdings', 'active', 'caddington.example', 'Reference tenant. Existing Caddington MCP knowledge environment.', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('co_ht', 'ht-business', 'HT Business', 'active', 'ht.example', 'Future primary connector: Commusoft. Not connected to live systems in v0.1.', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('co_el', 'el-business', 'EL Business', 'active', 'el.example', 'Future primary connector: BigChange. Not connected to live systems in v0.1.', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

INSERT OR REPLACE INTO mcp_environments (
  id, company_id, name, description, endpoint_url, transport, status,
  is_external, data_plane_id, last_health_check_at, last_healthy_at, health_message,
  created_at, updated_at
) VALUES (
  'mcp_caddington_primary',
  'co_caddington',
  'Caddington MCP',
  'Existing external MCP environment. Proven Google Drive → R2 → D1 → Vectorize knowledge stack. Managed by INFRA but not migrated in v0.1.',
  'https://caddington-mcp.example/mcp',
  'sse',
  'registered',
  1,
  'dp_caddington_knowledge',
  NULL,
  NULL,
  'Awaiting first health check',
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
    'healthy',
    '{"folderIds":["root"],"includeSharedDrives":true,"note":"Managed by external Caddington MCP"}',
    '{"enabled":true,"mode":"scheduled","schedule":"0 */6 * * *"}',
    'dp_caddington_knowledge',
    '2026-08-24T08:00:00.000Z',
    'completed',
    'Last sync managed by external Caddington MCP environment',
    'healthy',
    'Indexed via external knowledge environment',
    '2026-01-01T00:00:00.000Z',
    '2026-08-24T08:00:00.000Z'
  ),
  (
    'ci_ht_commusoft',
    'co_ht',
    'conn_commusoft',
    'HT Commusoft',
    'draft',
    '{"syncEntities":["customers","jobs","engineers"]}',
    '{"enabled":false,"mode":"manual","schedule":null}',
    NULL,
    NULL,
    NULL,
    'Not connected in v0.1',
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
    '{"authMode":"legacy","syncEntities":["customers","jobs","engineers","invoices"]}',
    '{"enabled":false,"mode":"manual","schedule":null}',
    NULL,
    NULL,
    NULL,
    'Not connected in v0.1',
    'unknown',
    'Awaiting credentials and live system connection',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z'
  );

INSERT OR REPLACE INTO credit_balances (company_id, balance_cents, currency, updated_at) VALUES
  ('co_caddington', 50000, 'GBP', '2026-08-24T00:00:00.000Z'),
  ('co_ht', 25000, 'GBP', '2026-08-24T00:00:00.000Z'),
  ('co_el', 25000, 'GBP', '2026-08-24T00:00:00.000Z');

INSERT OR REPLACE INTO audit_events (id, company_id, event_type, actor, resource_type, resource_id, detail_json, created_at) VALUES
  ('audit_seed_1', 'co_caddington', 'mcp.registered', 'infra-system', 'mcp', 'mcp_caddington_primary', '{"name":"Caddington MCP","isExternal":true}', '2026-01-01T00:00:00.000Z'),
  ('audit_seed_2', 'co_caddington', 'connector.instance_created', 'infra-system', 'connector', 'ci_caddington_gdrive', '{"connector":"google-drive"}', '2026-01-01T00:00:00.000Z'),
  ('audit_seed_3', 'co_ht', 'company.created', 'infra-system', 'company', 'co_ht', '{"name":"HT Business"}', '2026-01-01T00:00:00.000Z'),
  ('audit_seed_4', 'co_el', 'company.created', 'infra-system', 'company', 'co_el', '{"name":"EL Business"}', '2026-01-01T00:00:00.000Z'),
  ('audit_seed_5', 'co_ht', 'connector.instance_created', 'infra-system', 'connector', 'ci_ht_commusoft', '{"connector":"commusoft","status":"draft"}', '2026-01-02T00:00:00.000Z'),
  ('audit_seed_6', 'co_el', 'connector.instance_created', 'infra-system', 'connector', 'ci_el_bigchange', '{"connector":"bigchange","status":"draft"}', '2026-01-02T00:00:00.000Z');

INSERT OR REPLACE INTO sync_history (
  id, connector_instance_id, company_id, status, started_at, completed_at,
  items_processed, items_failed, message
) VALUES (
  'sync_caddington_1',
  'ci_caddington_gdrive',
  'co_caddington',
  'completed',
  '2026-08-24T07:55:00.000Z',
  '2026-08-24T08:00:00.000Z',
  142,
  0,
  'Historical sync record from external Caddington MCP environment'
);
