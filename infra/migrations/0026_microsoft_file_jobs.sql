-- Microsoft 365 per-file queue ingestion jobs (CMD14 scale hardening).

CREATE TABLE IF NOT EXISTS microsoft_file_jobs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  connector_instance_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  sync_run_id TEXT NOT NULL,
  external_item_id TEXT NOT NULL,
  drive_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  relative_path TEXT,
  mime_type TEXT,
  e_tag TEXT,
  modified_at TEXT,
  web_url TEXT,
  size_bytes INTEGER,
  action TEXT NOT NULL DEFAULT 'index'
    CHECK(action IN ('index', 'delete')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN (
      'queued', 'processing', 'indexed', 'skipped_unchanged',
      'unsupported', 'catalogue_only', 'failed', 'retrying', 'dead_letter'
    )),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (source_id) REFERENCES microsoft_connector_sources(id)
);

CREATE INDEX IF NOT EXISTS idx_microsoft_file_jobs_source
  ON microsoft_file_jobs(company_id, source_id, status);

CREATE INDEX IF NOT EXISTS idx_microsoft_file_jobs_sync_run
  ON microsoft_file_jobs(sync_run_id, status);

CREATE INDEX IF NOT EXISTS idx_microsoft_file_jobs_item
  ON microsoft_file_jobs(company_id, source_id, external_item_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_microsoft_file_jobs_active_item
  ON microsoft_file_jobs(company_id, source_id, external_item_id, e_tag)
  WHERE status IN ('queued', 'processing', 'retrying');
