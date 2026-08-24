-- INFRA control plane schema (v0.1)
-- Customer data plane resources are referenced by ID but not stored here.

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  primary_domain TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_environments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  description TEXT,
  endpoint_url TEXT NOT NULL,
  transport TEXT NOT NULL DEFAULT 'sse',
  status TEXT NOT NULL DEFAULT 'registered',
  is_external INTEGER NOT NULL DEFAULT 1,
  data_plane_id TEXT,
  last_health_check_at TEXT,
  last_healthy_at TEXT,
  health_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_environments_company ON mcp_environments(company_id);

CREATE TABLE IF NOT EXISTS connector_instances (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  connector_definition_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  config_json TEXT NOT NULL DEFAULT '{}',
  sync_settings_json TEXT NOT NULL DEFAULT '{}',
  data_environment_id TEXT,
  last_sync_at TEXT,
  last_sync_status TEXT,
  last_sync_message TEXT,
  health_status TEXT NOT NULL DEFAULT 'unknown',
  health_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_connector_instances_company ON connector_instances(company_id);
CREATE INDEX IF NOT EXISTS idx_connector_instances_definition ON connector_instances(connector_definition_id);

CREATE TABLE IF NOT EXISTS credential_refs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  connector_instance_id TEXT REFERENCES connector_instances(id),
  label TEXT NOT NULL,
  provider TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_credential_refs_company ON credential_refs(company_id);

CREATE TABLE IF NOT EXISTS permission_grants (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  actions_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_permission_grants_company ON permission_grants(company_id);

CREATE TABLE IF NOT EXISTS credit_balances (
  company_id TEXT PRIMARY KEY REFERENCES companies(id),
  balance_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'GBP',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_usage_records_company ON usage_records(company_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  company_id TEXT REFERENCES companies(id),
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_events_company ON audit_events(company_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at);

CREATE TABLE IF NOT EXISTS sync_history (
  id TEXT PRIMARY KEY,
  connector_instance_id TEXT NOT NULL REFERENCES connector_instances(id),
  company_id TEXT NOT NULL REFERENCES companies(id),
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  items_processed INTEGER NOT NULL DEFAULT 0,
  items_failed INTEGER NOT NULL DEFAULT 0,
  message TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_history_connector ON sync_history(connector_instance_id);
CREATE INDEX IF NOT EXISTS idx_sync_history_company ON sync_history(company_id);
