-- ChatGPT MCP OAuth (proxy authorization server) + Entra object-ID binding.

ALTER TABLE company_users ADD COLUMN microsoft_oid TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_company_users_microsoft_oid
  ON company_users (company_id, microsoft_oid)
  WHERE microsoft_oid IS NOT NULL;

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT,
  redirect_uris_json TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  client_secret_hash TEXT,
  grant_types_json TEXT NOT NULL DEFAULT '["authorization_code","refresh_token"]',
  response_types_json TEXT NOT NULL DEFAULT '["code"]',
  scope TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS oauth_authorize_states (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  client_state TEXT,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  scope TEXT,
  resource TEXT,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  oid TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  resource TEXT,
  scope TEXT,
  expires_at INTEGER NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  oid TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  resource TEXT,
  scope TEXT,
  expires_at INTEGER NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_oid
  ON oauth_refresh_tokens (oid, client_id);
