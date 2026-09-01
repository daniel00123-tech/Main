-- INFRA Continuous Quality Loop V1 (WhatsApp). Incremental only — do not replay 0025–0040.

CREATE TABLE IF NOT EXISTS quality_loop_config (
  id TEXT PRIMARY KEY,
  activated_at TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'daily',
  timezone TEXT NOT NULL DEFAULT 'Europe/London',
  daily_hour INTEGER NOT NULL DEFAULT 8,
  weekly_weekday INTEGER NOT NULL DEFAULT 5,
  phase1_days INTEGER NOT NULL DEFAULT 60,
  last_run_at TEXT,
  last_period_from TEXT,
  last_period_to TEXT,
  last_cadence TEXT,
  baseline_completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quality_runtime_config (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  config_json TEXT NOT NULL,
  proposal_id TEXT,
  canary_percent INTEGER NOT NULL DEFAULT 10,
  canary_company_id TEXT,
  created_at TEXT NOT NULL,
  promoted_at TEXT,
  rolled_back_at TEXT,
  rollback_reason TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_quality_runtime_version
  ON quality_runtime_config(version);

CREATE INDEX IF NOT EXISTS idx_quality_runtime_status
  ON quality_runtime_config(status, version DESC);

CREATE TABLE IF NOT EXISTS quality_loop_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  phase TEXT NOT NULL,
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  status TEXT NOT NULL,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  email_sent INTEGER NOT NULL DEFAULT 0,
  email_error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_quality_loop_runs_created
  ON quality_loop_runs(created_at DESC);

CREATE TABLE IF NOT EXISTS quality_conversation_scores (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  interaction_id TEXT,
  conversation_key TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  overall_score REAL NOT NULL,
  confidence REAL NOT NULL,
  failed INTEGER NOT NULL DEFAULT 0,
  permission_denial_correct INTEGER NOT NULL DEFAULT 0,
  dimensions_json TEXT NOT NULL,
  flags_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  evaluator_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quality_scores_run
  ON quality_conversation_scores(run_id, company_id);

CREATE INDEX IF NOT EXISTS idx_quality_scores_company
  ON quality_conversation_scores(company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS quality_patterns (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  company_id TEXT,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  root_cause TEXT,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  severity TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quality_patterns_run
  ON quality_patterns(run_id, company_id);

CREATE TABLE IF NOT EXISTS quality_proposals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  company_id TEXT,
  pattern_id TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  kind TEXT NOT NULL,
  risk TEXT NOT NULL,
  auto_applyable INTEGER NOT NULL DEFAULT 0,
  engineering_required INTEGER NOT NULL DEFAULT 0,
  patch_json TEXT NOT NULL DEFAULT '{}',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  pretest_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quality_proposals_run
  ON quality_proposals(run_id, status);

CREATE INDEX IF NOT EXISTS idx_quality_proposals_fingerprint
  ON quality_proposals(fingerprint, status);

CREATE TABLE IF NOT EXISTS quality_review_tokens (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quality_review_tokens_hash
  ON quality_review_tokens(token_hash);

CREATE TABLE IF NOT EXISTS quality_improvement_history (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  run_id TEXT,
  action TEXT NOT NULL,
  actor TEXT,
  runtime_version INTEGER,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quality_history_proposal
  ON quality_improvement_history(proposal_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_quality_history_action
  ON quality_improvement_history(action, created_at DESC);
