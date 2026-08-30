-- Platform connector registry metadata + company AI approval audit columns.
-- Additive. No secrets. Safe on production.
-- Human ChatGPT identity lives in 0039_mcp_user_oauth (ai_user_connections + OAuth tables).
-- Do not add per-user service-identity binding here.

ALTER TABLE connector_instances ADD COLUMN source_mcp_id TEXT;
ALTER TABLE connector_instances ADD COLUMN source_connector_code TEXT;
ALTER TABLE connector_instances ADD COLUMN last_verified_at TEXT;
ALTER TABLE connector_instances ADD COLUMN non_secret_metadata_json TEXT;

ALTER TABLE ai_client_connections ADD COLUMN approved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_client_connections ADD COLUMN approved_by TEXT;
ALTER TABLE ai_client_connections ADD COLUMN approved_at TEXT;

UPDATE ai_client_connections
SET approved = 1,
    approved_at = COALESCE(approved_at, updated_at)
WHERE channel_enabled = 1 AND approved = 0;

UPDATE mcp_environments
SET admin_secret_ref = 'EL_BUSINESS_MCP_ADMIN_TOKEN'
WHERE id = 'mcp_el_primary'
  AND (admin_secret_ref IS NULL OR admin_secret_ref = '');
