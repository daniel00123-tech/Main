-- Additive connector control-plane, capability snapshots, and OAuth state.
-- Safe to apply on production. No secret values. No destructive rewrites.

ALTER TABLE mcp_environments ADD COLUMN capability_snapshot_json TEXT;
ALTER TABLE mcp_environments ADD COLUMN capability_refreshed_at TEXT;

ALTER TABLE connector_instances ADD COLUMN credential_ref_id TEXT;
ALTER TABLE connector_instances ADD COLUMN external_account_id TEXT;
ALTER TABLE connector_instances ADD COLUMN display_account_name TEXT;
ALTER TABLE connector_instances ADD COLUMN auth_status TEXT;
ALTER TABLE connector_instances ADD COLUMN sync_health TEXT;
ALTER TABLE connector_instances ADD COLUMN provider_health TEXT;
ALTER TABLE connector_instances ADD COLUMN last_successful_sync_at TEXT;
ALTER TABLE connector_instances ADD COLUMN last_error_code TEXT;
ALTER TABLE connector_instances ADD COLUMN last_error_message TEXT;
ALTER TABLE connector_instances ADD COLUMN configured_by TEXT;
ALTER TABLE connector_instances ADD COLUMN connected_at TEXT;
ALTER TABLE connector_instances ADD COLUMN managed_by TEXT;
ALTER TABLE connector_instances ADD COLUMN last_health_at TEXT;
ALTER TABLE connector_instances ADD COLUMN capabilities_enabled_json TEXT;
ALTER TABLE connector_instances ADD COLUMN records_processed INTEGER;
ALTER TABLE connector_instances ADD COLUMN records_created INTEGER;
ALTER TABLE connector_instances ADD COLUMN records_updated INTEGER;
ALTER TABLE connector_instances ADD COLUMN records_failed INTEGER;
ALTER TABLE connector_instances ADD COLUMN sync_checkpoint TEXT;

ALTER TABLE credential_refs ADD COLUMN purpose TEXT;
ALTER TABLE credential_refs ADD COLUMN rotated_at TEXT;

CREATE TABLE IF NOT EXISTS oauth_authorization_states (
  id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  company_id TEXT NOT NULL REFERENCES companies(id),
  connector_definition_id TEXT NOT NULL,
  connector_instance_id TEXT,
  user_id TEXT NOT NULL,
  code_challenge TEXT,
  code_challenge_method TEXT,
  redirect_uri TEXT,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_hash ON oauth_authorization_states(state_hash);
CREATE INDEX IF NOT EXISTS idx_oauth_states_company ON oauth_authorization_states(company_id);
CREATE INDEX IF NOT EXISTS idx_connector_instances_managed ON connector_instances(managed_by);
CREATE INDEX IF NOT EXISTS idx_mcp_capability_refreshed ON mcp_environments(capability_refreshed_at);

-- Existing Caddington Drive instance is MCP-managed metadata, not an INFRA OAuth connection.
UPDATE connector_instances
SET
  managed_by = COALESCE(managed_by, 'company_mcp'),
  auth_status = COALESCE(auth_status, CASE
    WHEN status IN ('healthy', 'configured') THEN 'connected'
    WHEN status = 'error' THEN 'error'
    WHEN status IN ('draft') THEN 'not_configured'
    ELSE 'not_configured'
  END),
  sync_health = COALESCE(sync_health, CASE
    WHEN last_sync_status = 'failed' THEN 'failed'
    WHEN last_sync_status = 'running' THEN 'running'
    WHEN last_sync_status = 'completed' THEN 'completed'
    WHEN last_sync_at IS NOT NULL THEN 'idle'
    ELSE 'unknown'
  END),
  provider_health = COALESCE(provider_health, CASE
    WHEN health_status IN ('healthy', 'degraded', 'unhealthy') THEN health_status
    ELSE 'unknown'
  END)
WHERE id = 'ci_caddington_gdrive'
   OR connector_definition_id = 'conn_google_drive';

UPDATE connector_instances
SET
  managed_by = COALESCE(managed_by, 'infra'),
  auth_status = COALESCE(auth_status, 'not_configured'),
  sync_health = COALESCE(sync_health, 'not_applicable'),
  provider_health = COALESCE(provider_health, 'unknown')
WHERE managed_by IS NULL;
