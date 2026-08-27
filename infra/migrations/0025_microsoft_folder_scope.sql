-- Microsoft 365 folder-level source scoping and knowledge visibility.

ALTER TABLE microsoft_connector_sources ADD COLUMN folder_scope_mode TEXT DEFAULT 'all'
  CHECK(folder_scope_mode IN ('all', 'include_paths', 'exclude_paths'));
ALTER TABLE microsoft_connector_sources ADD COLUMN folder_include_paths_json TEXT;
ALTER TABLE microsoft_connector_sources ADD COLUMN folder_exclude_paths_json TEXT;

ALTER TABLE microsoft_knowledge_items ADD COLUMN visibility_status TEXT DEFAULT 'active'
  CHECK(visibility_status IN ('active', 'excluded', 'tombstoned'));

CREATE INDEX IF NOT EXISTS idx_microsoft_knowledge_visibility
  ON microsoft_knowledge_items(company_id, source_id, visibility_status);
