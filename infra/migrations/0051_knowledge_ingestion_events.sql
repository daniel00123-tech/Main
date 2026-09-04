-- Platform-wide knowledge ingestion event ledger.
-- Source of truth for daily knowledge-activity reporting. Tenant-scoped.

CREATE TABLE IF NOT EXISTS knowledge_ingestion_events (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  event_type TEXT NOT NULL
    CHECK(event_type IN (
      'discovered', 'fetched', 'extracted', 'indexed', 'reindexed',
      'skipped', 'duplicate', 'failed', 'source_observed'
    )),
  status TEXT NOT NULL
    CHECK(status IN (
      'discovered', 'fetched', 'extracted', 'indexed', 'reindexed',
      'skipped', 'duplicate', 'failed', 'source_observed'
    )),
  provider_item_id TEXT,
  parent_message_id TEXT,
  filename TEXT,
  content_hash TEXT,
  mailbox_address TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  chunk_count INTEGER,
  skip_reason TEXT,
  failure_code TEXT,
  discovered_at TEXT,
  source_modified_at TEXT,
  fetched_at TEXT,
  extracted_at TEXT,
  indexed_at TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_ingestion_events_company_window
  ON knowledge_ingestion_events(company_id, created_at);

CREATE INDEX IF NOT EXISTS idx_knowledge_ingestion_events_provider
  ON knowledge_ingestion_events(company_id, source_type, provider_item_id);
