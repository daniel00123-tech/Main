-- Microsoft 365 sync state extensions for app-only discovery and delta sync.

ALTER TABLE microsoft_connector_sources ADD COLUMN owner_upn TEXT;
ALTER TABLE microsoft_connector_sources ADD COLUMN owner_display_name TEXT;
ALTER TABLE microsoft_connector_sources ADD COLUMN drive_type TEXT;
ALTER TABLE microsoft_connector_sources ADD COLUMN site_id TEXT;
ALTER TABLE microsoft_connector_sources ADD COLUMN items_discovered INTEGER DEFAULT 0;
ALTER TABLE microsoft_connector_sources ADD COLUMN items_indexed INTEGER DEFAULT 0;
ALTER TABLE microsoft_connector_sources ADD COLUMN last_discovery_at TEXT;
ALTER TABLE microsoft_connector_sources ADD COLUMN delta_link TEXT;
ALTER TABLE microsoft_connector_sources ADD COLUMN delta_token TEXT;

ALTER TABLE microsoft_knowledge_items ADD COLUMN knowledge_document_id INTEGER;
ALTER TABLE microsoft_knowledge_items ADD COLUMN external_id TEXT;
ALTER TABLE microsoft_knowledge_items ADD COLUMN web_url TEXT;
ALTER TABLE microsoft_knowledge_items ADD COLUMN size_bytes INTEGER;
ALTER TABLE microsoft_knowledge_items ADD COLUMN indexing_status TEXT DEFAULT 'pending'
  CHECK(indexing_status IN ('pending', 'indexed', 'unsupported', 'failed', 'deleted', 'skipped'));
ALTER TABLE microsoft_knowledge_items ADD COLUMN last_error TEXT;
ALTER TABLE microsoft_knowledge_items ADD COLUMN e_tag TEXT;
ALTER TABLE microsoft_knowledge_items ADD COLUMN content_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_microsoft_knowledge_external_id
  ON microsoft_knowledge_items(company_id, connector_instance_id, external_id)
  WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS microsoft_sync_runs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  connector_instance_id TEXT NOT NULL,
  run_type TEXT NOT NULL CHECK(run_type IN ('discovery', 'sync', 'full_sync')),
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'partial')),
  sources_processed INTEGER DEFAULT 0,
  items_discovered INTEGER DEFAULT 0,
  items_indexed INTEGER DEFAULT 0,
  items_failed INTEGER DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_summary TEXT,
  metadata_json TEXT,
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE INDEX IF NOT EXISTS idx_microsoft_sync_runs_company ON microsoft_sync_runs(company_id);
