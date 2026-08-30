-- Xero OAuth state + encrypted token store for EL Business MCP.
-- Refresh tokens are stored only as AES-256-GCM ciphertext. Never plaintext.

CREATE TABLE IF NOT EXISTS xero_oauth_states (
  state_hash TEXT PRIMARY KEY,
  code_verifier_nonce TEXT NOT NULL,
  code_verifier_ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS xero_connections (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  tenant_id TEXT NOT NULL,
  organisation_name TEXT,
  connection_id TEXT,
  scopes TEXT,
  token_nonce TEXT NOT NULL,
  token_ciphertext TEXT NOT NULL,
  access_expires_at TEXT,
  refresh_lock_until TEXT,
  last_refresh_at TEXT,
  last_api_at TEXT,
  last_api_ok INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

UPDATE connector_registry
SET
  status = 'configured',
  config_secret_name = 'EL_XERO_CLIENT_SECRET',
  notes = 'Xero OAuth for Elvex Property Services Ltd. Tokens encrypted in D1. Tenant isolated to the expected Elvex organisation.',
  updated_at = datetime('now')
WHERE code = 'xero';
