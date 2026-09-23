-- Customer economics V1, interaction access audit, quality issues,
-- platform overheads, and WhatsApp identity foundation.
-- Does not create a second cost ledger. Does not enable WhatsApp messaging.

-- ---------- Users: mobile identity (existing users remain usable) ----------
ALTER TABLE users ADD COLUMN mobile_e164 TEXT;
ALTER TABLE users ADD COLUMN mobile_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN mobile_verified_at TEXT;
ALTER TABLE users ADD COLUMN mobile_verification_required INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_mobile_e164
  ON users(mobile_e164)
  WHERE mobile_e164 IS NOT NULL;

UPDATE users
  SET mobile_verification_required = 1
  WHERE mobile_e164 IS NULL;

-- ---------- Platform overheads (NOT allocated to tenants in V1) ----------
CREATE TABLE IF NOT EXISTS platform_overheads (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  description TEXT NOT NULL,
  monthly_cost_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GBP',
  start_date TEXT NOT NULL,
  end_date TEXT,
  category TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_platform_overheads_active
  ON platform_overheads(start_date, end_date);

-- ---------- Interaction body access log (super-admin / support only) ----------
CREATE TABLE IF NOT EXISTS interaction_access_log (
  id TEXT PRIMARY KEY,
  interaction_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  viewer_user_id TEXT NOT NULL,
  viewer_email TEXT NOT NULL,
  purpose TEXT,
  viewed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_interaction_access_interaction
  ON interaction_access_log(interaction_id, viewed_at DESC);

CREATE INDEX IF NOT EXISTS idx_interaction_access_viewer
  ON interaction_access_log(viewer_user_id, viewed_at DESC);

-- ---------- Quality / issue queue (proposals only — never auto-changes prod) ----------
CREATE TABLE IF NOT EXISTS quality_issues (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  company_id TEXT,
  user_id TEXT,
  last_interaction_id TEXT,
  channel TEXT,
  category TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  confidence REAL NOT NULL DEFAULT 0.5,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  suggested_investigation TEXT,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_quality_issues_fingerprint
  ON quality_issues(fingerprint);

CREATE INDEX IF NOT EXISTS idx_quality_issues_status
  ON quality_issues(status, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_quality_issues_company
  ON quality_issues(company_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS quality_issue_events (
  id TEXT PRIMARY KEY,
  quality_issue_id TEXT NOT NULL REFERENCES quality_issues(id),
  interaction_id TEXT,
  company_id TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quality_issue_events_issue
  ON quality_issue_events(quality_issue_id, created_at DESC);

-- ---------- Channel config placeholder (WhatsApp disabled) ----------
CREATE TABLE IF NOT EXISTS channel_config (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 0,
  welcome_message_template TEXT,
  notes TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO channel_config (
  id, channel, enabled, welcome_message_template, notes, config_json, created_at, updated_at
) VALUES (
  'chcfg_whatsapp',
  'whatsapp',
  0,
  'Hi [Name], welcome to Infra. You can message this number whenever you need help with your connected business systems.',
  'Foundation only. Do not send. Do not register a Meta template. Production WhatsApp is not enabled.',
  '{"production_enabled":false,"require_verified_mobile":true}',
  '2026-08-29T00:00:00.000Z',
  '2026-08-29T00:00:00.000Z'
);
