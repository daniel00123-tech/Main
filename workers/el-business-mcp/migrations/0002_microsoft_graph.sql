-- Microsoft 365 catalogue + connector activation for EL Business MCP.
-- Does not store tokens or secrets.

CREATE TABLE IF NOT EXISTS microsoft_index_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL CHECK (source_type IN ('sharepoint', 'onedrive')),
  source_id TEXT,
  drive_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  owner_id TEXT,
  owner_upn TEXT,
  web_url TEXT,
  filename TEXT,
  modified_at TEXT,
  status TEXT NOT NULL DEFAULT 'catalogue'
    CHECK (status IN ('catalogue', 'indexed', 'excluded_protected', 'deleted')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (drive_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_microsoft_index_owner ON microsoft_index_items (owner_id);
CREATE INDEX IF NOT EXISTS idx_microsoft_index_status ON microsoft_index_items (status);
CREATE INDEX IF NOT EXISTS idx_microsoft_index_modified ON microsoft_index_items (modified_at);

INSERT OR IGNORE INTO connector_registry (code, label, category, status, config_secret_name, notes)
VALUES (
  'outlook_calendar',
  'Outlook Calendar',
  'calendar',
  'configured',
  'EL_MS_CLIENT_SECRET',
  'Approved shared-mailbox calendars only (finance@ / info@). Personal calendars are not exposed.'
);

UPDATE connector_registry
SET
  status = 'configured',
  config_secret_name = 'EL_MS_CLIENT_SECRET',
  notes = 'Microsoft Graph via EL_MS_* Worker credentials. Mailbox allowlist enforced in EL Business MCP.',
  updated_at = datetime('now')
WHERE code IN ('sharepoint', 'onedrive', 'outlook_shared_mailbox');
