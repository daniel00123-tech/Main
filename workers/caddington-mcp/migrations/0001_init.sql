-- Caddington MCP v1 — D1 warehouse, knowledge metadata, connector registry

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

INSERT OR IGNORE INTO connector_registry (code, label, category, status, config_secret_name, notes) VALUES
  ('outlook_graph', 'Microsoft Outlook / Graph', 'email', 'disabled', 'OUTLOOK_GRAPH_CREDENTIALS', 'Future OAuth app credentials'),
  ('onedrive_sharepoint', 'OneDrive / SharePoint', 'documents', 'disabled', 'MICROSOFT_DRIVE_CREDENTIALS', 'Future Microsoft 365 integration'),
  ('google_drive', 'Google Drive', 'documents', 'disabled', 'GOOGLE_DRIVE_CREDENTIALS', 'Future Google Drive integration'),
  ('google_sheets', 'Google Sheets', 'data', 'disabled', 'GOOGLE_SHEETS_CREDENTIALS', 'Future Google Sheets integration'),
  ('xero', 'Xero', 'finance', 'disabled', 'XERO_CREDENTIALS', 'Future Xero accounting integration'),
  ('commusoft', 'Commusoft', 'operations', 'disabled', 'COMMUSOFT_CREDENTIALS', 'Future Commusoft field service integration'),
  ('bigchange', 'BigChange', 'operations', 'disabled', 'BIGCHANGE_CREDENTIALS', 'Future BigChange integration'),
  ('goto', 'GoTo', 'communications', 'disabled', 'GOTO_CREDENTIALS', 'Future GoTo integration'),
  ('whatsapp', 'WhatsApp', 'communications', 'disabled', 'WHATSAPP_CREDENTIALS', 'Future WhatsApp Business integration');

CREATE TABLE IF NOT EXISTS entity_registry (
  entity_type TEXT PRIMARY KEY,
  description TEXT,
  source_systems TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO entity_registry (entity_type, description, source_systems) VALUES
  ('job', 'Operational jobs', 'csv,commusoft,bigchange'),
  ('customer', 'Customer accounts', 'csv,commusoft'),
  ('invoice', 'Invoices', 'csv,xero,commusoft'),
  ('quote', 'Quotes', 'csv,commusoft');

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

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  r2_key TEXT NOT NULL,
  mime_type TEXT,
  byte_size INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'indexed', 'failed')),
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  indexed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_documents_external ON knowledge_documents (external_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_status ON knowledge_documents (status);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES knowledge_documents (id),
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  vector_id TEXT,
  token_estimate INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document ON knowledge_chunks (document_id);

CREATE TABLE IF NOT EXISTS knowledge_import_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER REFERENCES knowledge_documents (id),
  operation TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  chunks_processed INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_knowledge_import_log_document ON knowledge_import_log (document_id);
