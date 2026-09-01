-- Reference warehouse schema for Business MCP Core company MCPs.
-- Apply via each company worker's migrations/ directory with company-specific naming.

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
