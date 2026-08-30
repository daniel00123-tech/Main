-- EL Business MCP Phase 3 — framework foundation (no business records)

CREATE TABLE IF NOT EXISTS import_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_system TEXT NOT NULL,
  import_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  records_processed INTEGER NOT NULL DEFAULT 0,
  records_failed INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_import_log_source ON import_log (source_system);
CREATE INDEX IF NOT EXISTS idx_import_log_started_at ON import_log (started_at);

CREATE TABLE IF NOT EXISTS system_health_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  overall_status TEXT NOT NULL,
  mcp_version TEXT NOT NULL,
  d1_status TEXT NOT NULL,
  r2_status TEXT NOT NULL,
  vectorize_status TEXT NOT NULL,
  details TEXT
);

CREATE INDEX IF NOT EXISTS idx_system_health_log_checked_at ON system_health_log (checked_at);

CREATE TABLE IF NOT EXISTS connector_registry (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'integration',
  status TEXT NOT NULL DEFAULT 'disabled' CHECK (status IN ('disabled', 'configured', 'active')),
  config_secret_name TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS connector_config (
  connector_code TEXT PRIMARY KEY REFERENCES connector_registry (code),
  config_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO connector_registry (code, label, category, status, config_secret_name, notes) VALUES
  ('bigchange', 'BigChange', 'operations', 'disabled', 'BIGCHANGE_CREDENTIALS', 'Future EL field service integration — not configured'),
  ('sharepoint', 'SharePoint', 'documents', 'disabled', 'MICROSOFT_SHAREPOINT_CREDENTIALS', 'Future EL company document library — not configured'),
  ('onedrive', 'OneDrive', 'documents', 'disabled', 'MICROSOFT_ONEDRIVE_CREDENTIALS', 'Future EL shared OneDrive — not configured'),
  ('xero', 'Xero', 'finance', 'disabled', 'XERO_CREDENTIALS', 'Future EL accounting integration — not configured'),
  ('outlook_shared_mailbox', 'Outlook Shared Mailbox', 'email', 'disabled', 'OUTLOOK_SHARED_MAILBOX_CREDENTIALS', 'Future EL shared mailbox — not configured'),
  ('freshdesk', 'Freshdesk', 'support', 'disabled', 'FRESHDESK_CREDENTIALS', 'Future EL support integration — not configured');

CREATE TABLE IF NOT EXISTS entity_registry (
  entity_type TEXT PRIMARY KEY,
  description TEXT,
  source_systems TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS entity_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  source_system TEXT NOT NULL DEFAULT 'unknown',
  external_id TEXT,
  record_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  import_batch_id INTEGER REFERENCES import_log (id),
  data TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_entity_records_type ON entity_records (entity_type);
CREATE INDEX IF NOT EXISTS idx_entity_records_source ON entity_records (source_system);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_records_unique_external
  ON entity_records (source_system, entity_type, external_id)
  WHERE external_id IS NOT NULL;
