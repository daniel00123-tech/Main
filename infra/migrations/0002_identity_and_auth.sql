-- INFRA identity, membership, and permission foundation (Phase 1)

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  is_platform_admin INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS company_memberships (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  company_id TEXT NOT NULL REFERENCES companies(id),
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_company_memberships_user ON company_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_company_memberships_company ON company_memberships(company_id);

CREATE TABLE IF NOT EXISTS role_action_grants (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  role TEXT NOT NULL,
  action TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(company_id, role, action)
);

CREATE INDEX IF NOT EXISTS idx_role_action_grants_company ON role_action_grants(company_id);

CREATE TABLE IF NOT EXISTS service_identities (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  secret_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_service_identities_company ON service_identities(company_id);

ALTER TABLE mcp_environments ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE mcp_environments ADD COLUMN mcp_version TEXT;
ALTER TABLE mcp_environments ADD COLUMN business_mcp_core_version TEXT;
ALTER TABLE mcp_environments ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE mcp_environments ADD COLUMN auth_secret_ref TEXT;
