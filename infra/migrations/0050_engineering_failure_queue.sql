-- Async engineering failure queue. Never on the customer turn path.

CREATE TABLE IF NOT EXISTS engineering_failure_events (
  id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  company_id TEXT,
  channel TEXT,
  capability TEXT,
  tool_name TEXT,
  model TEXT,
  provider TEXT,
  category TEXT NOT NULL,
  latency_ms INTEGER,
  outcome TEXT,
  metadata_json TEXT,
  cluster_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_engineering_failure_events_cluster
  ON engineering_failure_events(cluster_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_engineering_failure_events_company
  ON engineering_failure_events(company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS engineering_failure_clusters (
  cluster_key TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  capability TEXT,
  tool_name TEXT,
  occurrence_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  work_item_id TEXT,
  sample_correlation_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_engineering_failure_clusters_status
  ON engineering_failure_clusters(status, occurrence_count DESC);
