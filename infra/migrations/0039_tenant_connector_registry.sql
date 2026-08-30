-- Platform connector registry metadata + company AI policy vs user AI connections.
-- Additive. No secrets. Safe on production.

ALTER TABLE connector_instances ADD COLUMN source_mcp_id TEXT;
ALTER TABLE connector_instances ADD COLUMN source_connector_code TEXT;
ALTER TABLE connector_instances ADD COLUMN last_verified_at TEXT;
ALTER TABLE connector_instances ADD COLUMN non_secret_metadata_json TEXT;

ALTER TABLE ai_client_connections ADD COLUMN approved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_client_connections ADD COLUMN approved_by TEXT;
ALTER TABLE ai_client_connections ADD COLUMN approved_at TEXT;

ALTER TABLE service_identities ADD COLUMN bound_user_id TEXT;

CREATE TABLE IF NOT EXISTS user_ai_connections (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  channel TEXT NOT NULL,
  external_identity TEXT,
  status TEXT NOT NULL,
  connected_at TEXT,
  last_seen TEXT,
  revoked_at TEXT,
  service_identity_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(company_id, user_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_user_ai_connections_company ON user_ai_connections(company_id);
CREATE INDEX IF NOT EXISTS idx_user_ai_connections_user ON user_ai_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_service_identities_bound_user ON service_identities(bound_user_id);

UPDATE mcp_environments
SET admin_secret_ref = 'EL_BUSINESS_MCP_ADMIN_TOKEN'
WHERE id = 'mcp_el_primary'
  AND (admin_secret_ref IS NULL OR admin_secret_ref = '');

CREATE TABLE IF NOT EXISTS ai_oauth_codes (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  channel TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_oauth_codes_company ON ai_oauth_codes(company_id);
