-- Tenant-configurable Microsoft 365 knowledge-intake landing zone.
-- Platform-wide: each company maps its own SharePoint library. Disabled until configured.

CREATE TABLE IF NOT EXISTS knowledge_intake_targets (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'microsoft_365',
  site_id TEXT,
  drive_id TEXT,
  root_folder_id TEXT,
  root_folder_path TEXT,
  web_url TEXT,
  status TEXT NOT NULL DEFAULT 'unconfigured'
    CHECK(status IN ('unconfigured', 'ready', 'error', 'disabled')),
  last_error TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_intake_targets_company
  ON knowledge_intake_targets(company_id, status);
