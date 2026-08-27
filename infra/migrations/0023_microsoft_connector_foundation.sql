-- Microsoft 365 connector foundation: tenant-scoped source selection and sync state.

CREATE TABLE IF NOT EXISTS microsoft_connector_sources (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  connector_instance_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('onedrive', 'sharepoint', 'outlook_shared')),
  external_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  path_or_url TEXT,
  mailbox_address TEXT,
  inclusion_status TEXT NOT NULL DEFAULT 'excluded' CHECK(inclusion_status IN ('included', 'excluded', 'available')),
  sync_status TEXT NOT NULL DEFAULT 'pending' CHECK(sync_status IN ('pending', 'syncing', 'healthy', 'needs_attention', 'error')),
  last_sync_at TEXT,
  last_error TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (connector_instance_id) REFERENCES connector_instances(id)
);

CREATE INDEX IF NOT EXISTS idx_microsoft_sources_company ON microsoft_connector_sources(company_id);
CREATE INDEX IF NOT EXISTS idx_microsoft_sources_instance ON microsoft_connector_sources(connector_instance_id);

CREATE TABLE IF NOT EXISTS microsoft_knowledge_items (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  connector_instance_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  external_item_id TEXT NOT NULL,
  title TEXT NOT NULL,
  path TEXT,
  mime_type TEXT,
  modified_at TEXT,
  provenance_json TEXT NOT NULL,
  indexed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (source_id) REFERENCES microsoft_connector_sources(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_microsoft_knowledge_item_unique
  ON microsoft_knowledge_items(company_id, connector_instance_id, external_item_id);

CREATE INDEX IF NOT EXISTS idx_microsoft_knowledge_company ON microsoft_knowledge_items(company_id);
