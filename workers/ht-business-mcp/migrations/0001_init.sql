-- HT Business data warehouse v0.1 — extensible schema for operational imports

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

CREATE TABLE IF NOT EXISTS entity_registry (
  entity_type TEXT PRIMARY KEY,
  description TEXT,
  source_systems TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO entity_registry (entity_type, description, source_systems) VALUES
  ('job', 'Operational jobs and work orders', 'csv,commusoft,bigchange'),
  ('sale', 'Sales and revenue records', 'csv,commusoft'),
  ('engineer', 'Engineer and technician records', 'csv,bigchange'),
  ('cost', 'Cost and expense records', 'csv,commusoft,bigchange'),
  ('margin', 'Margin and profitability metrics', 'csv');

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
CREATE INDEX IF NOT EXISTS idx_entity_records_record_date ON entity_records (record_date);
CREATE INDEX IF NOT EXISTS idx_entity_records_import_batch ON entity_records (import_batch_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_records_unique_external
  ON entity_records (entity_type, source_system, external_id)
  WHERE external_id IS NOT NULL;
