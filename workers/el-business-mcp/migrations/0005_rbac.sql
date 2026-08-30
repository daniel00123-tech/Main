-- Elvex company RBAC: users, service principals, classifications, audit.

CREATE TABLE IF NOT EXISTS company_users (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'co_el',
  external_id TEXT,
  email TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL CHECK (role IN (
    'engineer',
    'office_staff',
    'finance_team',
    'operations_manager',
    'finance_manager',
    'director',
    'company_admin'
  )),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_activity_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_company_users_email
  ON company_users (company_id, email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_company_users_external
  ON company_users (company_id, external_id)
  WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS company_service_principals (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'co_el',
  email TEXT,
  display_name TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS content_classifications (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'co_el',
  item_key TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN (
    'engineer_knowledge',
    'company_general',
    'finance',
    'restricted_management'
  )),
  source TEXT NOT NULL CHECK (source IN ('explicit', 'directory')),
  path_pattern TEXT,
  flagged_terms TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, item_key)
);

CREATE INDEX IF NOT EXISTS idx_content_classifications_class
  ON content_classifications (company_id, classification);

CREATE TABLE IF NOT EXISTS permission_audit_log (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'co_el',
  actor_id TEXT,
  actor_role TEXT,
  principal_type TEXT NOT NULL DEFAULT 'user',
  capability TEXT NOT NULL,
  resource TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
  reason TEXT,
  correlation_id TEXT,
  detail_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_permission_audit_created
  ON permission_audit_log (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_permission_audit_capability
  ON permission_audit_log (company_id, capability, decision);

-- Seed conservative directory classifications. Company Admin can reclassify.
INSERT OR IGNORE INTO content_classifications (
  id, company_id, item_key, classification, source, path_pattern, flagged_terms
) VALUES
  ('cls_dir_engineer', 'co_el', 'directory:engineer-knowledge', 'engineer_knowledge', 'directory', 'engineer knowledge', NULL),
  ('cls_dir_engineer_sop', 'co_el', 'directory:engineer-sops', 'engineer_knowledge', 'directory', '/sops/', NULL),
  ('cls_dir_board', 'co_el', 'directory:board', 'restricted_management', 'directory', '/board', 'board'),
  ('cls_dir_hr', 'co_el', 'directory:hr', 'restricted_management', 'directory', '/hr', 'hr'),
  ('cls_dir_finance', 'co_el', 'directory:finance', 'finance', 'directory', '/finance', NULL);
