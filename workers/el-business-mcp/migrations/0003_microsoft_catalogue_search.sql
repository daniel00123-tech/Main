-- Expand Microsoft file catalogue for bounded incremental search.

ALTER TABLE microsoft_index_items ADD COLUMN owner_name TEXT;
ALTER TABLE microsoft_index_items ADD COLUMN path TEXT;
ALTER TABLE microsoft_index_items ADD COLUMN mime_type TEXT;
ALTER TABLE microsoft_index_items ADD COLUMN size INTEGER;
ALTER TABLE microsoft_index_items ADD COLUMN search_text TEXT;

CREATE INDEX IF NOT EXISTS idx_microsoft_index_filename ON microsoft_index_items (filename);
CREATE INDEX IF NOT EXISTS idx_microsoft_index_search ON microsoft_index_items (search_text);

CREATE TABLE IF NOT EXISTS microsoft_sync_state (
  drive_id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  owner_id TEXT,
  site_id TEXT,
  delta_link TEXT,
  item_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
