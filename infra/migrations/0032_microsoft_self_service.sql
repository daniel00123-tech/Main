-- Microsoft 365 self-service onboarding (Backlog Sprint 2)
-- Per-company auth mode, admin consent binding, audit-friendly timestamps.

ALTER TABLE connector_instances ADD COLUMN microsoft_auth_mode TEXT;
ALTER TABLE connector_instances ADD COLUMN microsoft_consented_at TEXT;
ALTER TABLE connector_instances ADD COLUMN microsoft_consented_by TEXT;

CREATE INDEX IF NOT EXISTS idx_connector_instances_microsoft_auth
  ON connector_instances(company_id, connector_definition_id, microsoft_auth_mode);
