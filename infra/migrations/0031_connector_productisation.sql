-- Connector productisation framework — onboarding progress + MCP admin bridge refs.

ALTER TABLE mcp_environments ADD COLUMN admin_secret_ref TEXT;

ALTER TABLE connector_instances ADD COLUMN setup_progress_json TEXT;

CREATE INDEX IF NOT EXISTS idx_connector_instances_definition
  ON connector_instances(company_id, connector_definition_id);
