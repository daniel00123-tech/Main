-- INFRA-as-OAuth authorization server for human MCP (ChatGPT/Claude).
-- Access tokens are short-lived JWTs; refresh tokens and codes are hashed in D1.
-- Roles are never stored on tokens — live company_memberships is authoritative.

CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY,
  company_id TEXT,
  client_secret_hash TEXT,
  client_name TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL,
  grant_types_json TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  client_kind TEXT NOT NULL DEFAULT 'public',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  scope TEXT NOT NULL DEFAULT 'mcp',
  resource TEXT,
  channel TEXT NOT NULL DEFAULT 'chatgpt',
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_hash ON oauth_authorization_codes (code_hash);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'mcp',
  resource TEXT,
  channel TEXT NOT NULL DEFAULT 'chatgpt',
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_hash ON oauth_refresh_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_user ON oauth_refresh_tokens (user_id, company_id);

CREATE TABLE IF NOT EXISTS oauth_access_jti (
  jti TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_user_connections (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  client_type TEXT NOT NULL,
  oauth_client_id TEXT,
  status TEXT NOT NULL DEFAULT 'connected',
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (company_id, user_id, client_type)
);

CREATE INDEX IF NOT EXISTS idx_ai_user_connections_company
  ON ai_user_connections (company_id, client_type);

-- Company-wide AI channel approval (distinct from per-employee OAuth bind).
-- Existing connected rows are treated as enabled by application logic.
ALTER TABLE ai_client_connections ADD COLUMN channel_enabled INTEGER NOT NULL DEFAULT 0;
