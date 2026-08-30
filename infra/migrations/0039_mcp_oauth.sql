-- INFRA-native MCP OAuth for ChatGPT/Claude/future AI clients.
-- Human identity is the existing users + company_memberships tables.
-- Tokens never store a role; membership is resolved at execution time.

CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  client_name TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  client_secret_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  resource TEXT,
  scope TEXT,
  client_type TEXT NOT NULL DEFAULT 'chatgpt',
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_oauth_refresh_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  resource TEXT,
  scope TEXT,
  client_type TEXT NOT NULL DEFAULT 'chatgpt',
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_oauth_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  client_type TEXT NOT NULL,
  client_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  UNIQUE(user_id, company_id, client_type)
);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_user ON mcp_oauth_codes (user_id, company_id);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_refresh_user ON mcp_oauth_refresh_tokens (user_id, company_id);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_grants_company ON mcp_oauth_grants (company_id, client_type);
