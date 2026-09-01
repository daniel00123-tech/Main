-- HT Business MCP Phase 4 — additive connector framework (no data changes)

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

CREATE TABLE IF NOT EXISTS connector_config (
  connector_code TEXT PRIMARY KEY REFERENCES connector_registry (code),
  config_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO connector_registry (code, label, category, status, config_secret_name, notes) VALUES
  ('commusoft', 'Commusoft', 'operations', 'disabled', 'COMMUSOFT_CREDENTIALS', 'Future HT field service integration — not configured'),
  ('sharepoint', 'SharePoint', 'documents', 'disabled', 'MICROSOFT_SHAREPOINT_CREDENTIALS', 'Future HT company document library — not configured'),
  ('onedrive', 'OneDrive', 'documents', 'disabled', 'MICROSOFT_ONEDRIVE_CREDENTIALS', 'Future HT shared OneDrive — not configured'),
  ('xero', 'Xero', 'finance', 'disabled', 'XERO_CREDENTIALS', 'Future HT accounting integration — not configured'),
  ('outlook_shared_mailbox', 'Outlook Shared Mailbox', 'email', 'disabled', 'OUTLOOK_SHARED_MAILBOX_CREDENTIALS', 'Future HT shared mailbox — not configured');
