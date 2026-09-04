-- INFRA autonomous daily self-improvement loop.
-- Additive only. No drops. No billing-history rewrite.

CREATE TABLE IF NOT EXISTS daily_improvement_interactions (
  id TEXT PRIMARY KEY,
  interaction_id TEXT NOT NULL UNIQUE,
  customer_request_id TEXT,
  company_id TEXT NOT NULL,
  user_id TEXT,
  role TEXT,
  channel TEXT NOT NULL,
  conversation_id TEXT,
  created_at TEXT NOT NULL,
  user_message TEXT,
  provider TEXT,
  model TEXT,
  provider_mode TEXT,
  available_capabilities_json TEXT NOT NULL DEFAULT '[]',
  tools_requested_json TEXT NOT NULL DEFAULT '[]',
  tools_executed_json TEXT NOT NULL DEFAULT '[]',
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  assistant_answer TEXT,
  terminal_state TEXT,
  latency_ms INTEGER,
  customer_charge_cents INTEGER NOT NULL DEFAULT 0,
  provider_cost_cents INTEGER,
  quality_result TEXT,
  correlation_id TEXT,
  traffic_class TEXT NOT NULL DEFAULT 'CUSTOMER_REQUEST',
  source_client TEXT
);

CREATE INDEX IF NOT EXISTS idx_daily_imp_interactions_created
  ON daily_improvement_interactions(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_daily_imp_interactions_company
  ON daily_improvement_interactions(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_daily_imp_interactions_channel
  ON daily_improvement_interactions(channel, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_daily_imp_interactions_conversation
  ON daily_improvement_interactions(company_id, conversation_id, created_at);

CREATE TABLE IF NOT EXISTS daily_improvement_evaluations (
  id TEXT PRIMARY KEY,
  interaction_id TEXT NOT NULL,
  conversation_id TEXT,
  run_id TEXT,
  company_id TEXT NOT NULL,
  channel TEXT,
  overall_score INTEGER NOT NULL,
  intent INTEGER NOT NULL,
  tool_selection INTEGER NOT NULL,
  exact_tool INTEGER NOT NULL,
  rbac INTEGER NOT NULL,
  grounding INTEGER NOT NULL,
  first_answer INTEGER NOT NULL,
  completeness INTEGER NOT NULL,
  memory INTEGER NOT NULL,
  follow_up INTEGER NOT NULL,
  naturalness INTEGER NOT NULL,
  efficiency INTEGER NOT NULL,
  hallucination INTEGER NOT NULL,
  reliability INTEGER NOT NULL,
  user_effort INTEGER NOT NULL,
  failure_categories_json TEXT NOT NULL DEFAULT '[]',
  severity TEXT,
  notes TEXT,
  evaluator_model TEXT,
  evaluator_kind TEXT NOT NULL DEFAULT 'heuristic',
  traffic_class TEXT NOT NULL DEFAULT 'QUALITY',
  customer_charge_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_daily_imp_eval_run
  ON daily_improvement_evaluations(run_id, company_id);

CREATE INDEX IF NOT EXISTS idx_daily_imp_eval_interaction
  ON daily_improvement_evaluations(interaction_id, created_at DESC);

CREATE TABLE IF NOT EXISTS daily_improvement_clusters (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  cluster_key TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  severity TEXT NOT NULL,
  interaction_count INTEGER NOT NULL DEFAULT 0,
  tenant_count INTEGER NOT NULL DEFAULT 0,
  company_ids_json TEXT NOT NULL DEFAULT '[]',
  current_behaviour TEXT,
  expected_behaviour TEXT,
  root_cause TEXT,
  proposed_fix TEXT,
  risk TEXT,
  tests_required TEXT,
  expected_benefit TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_imp_clusters_run_key
  ON daily_improvement_clusters(run_id, cluster_key);

CREATE TABLE IF NOT EXISTS daily_improvement_issues (
  id TEXT PRIMARY KEY,
  cluster_id TEXT,
  run_id TEXT,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  priority_score REAL NOT NULL DEFAULT 0,
  affected_interactions INTEGER NOT NULL DEFAULT 0,
  affected_tenants INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_daily_imp_issues_status
  ON daily_improvement_issues(status, severity, priority_score DESC);

CREATE TABLE IF NOT EXISTS daily_improvement_runs (
  id TEXT PRIMARY KEY,
  run_date TEXT NOT NULL,
  kind TEXT NOT NULL,
  window_from TEXT,
  window_to TEXT,
  status TEXT NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}',
  email_sent_at TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(run_date, kind)
);

CREATE INDEX IF NOT EXISTS idx_daily_imp_runs_date
  ON daily_improvement_runs(run_date DESC, kind);

CREATE TABLE IF NOT EXISTS daily_improvement_engineering_jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  issue_id TEXT,
  cluster_key TEXT,
  title TEXT,
  severity TEXT,
  status TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at TEXT,
  job_spec_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_daily_imp_jobs_status
  ON daily_improvement_engineering_jobs(status, created_at);

CREATE TABLE IF NOT EXISTS daily_improvement_deployments (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  job_id TEXT,
  branch TEXT,
  sha TEXT,
  previous_sha TEXT,
  deployed_at TEXT,
  verified_at TEXT,
  verification_status TEXT NOT NULL DEFAULT 'PENDING',
  rollback_at TEXT,
  rollback_reason TEXT,
  quality_before REAL,
  quality_after REAL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_improvement_history (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  event_type TEXT NOT NULL,
  interaction_id TEXT,
  cluster_id TEXT,
  issue_id TEXT,
  job_id TEXT,
  deployment_id TEXT,
  company_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_daily_imp_history_created
  ON daily_improvement_history(created_at DESC);

CREATE TABLE IF NOT EXISTS daily_improvement_config (
  id TEXT PRIMARY KEY,
  timezone TEXT NOT NULL DEFAULT 'Europe/London',
  qa_hour INTEGER NOT NULL DEFAULT 16,
  qa_minute INTEGER NOT NULL DEFAULT 30,
  report_hour INTEGER NOT NULL DEFAULT 17,
  report_minute INTEGER NOT NULL DEFAULT 0,
  engineering_hour INTEGER NOT NULL DEFAULT 17,
  engineering_minute INTEGER NOT NULL DEFAULT 5,
  bootstrap_completed_at TEXT,
  last_qa_at TEXT,
  last_report_at TEXT,
  last_engineering_at TEXT,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO daily_improvement_config (
  id, timezone, qa_hour, qa_minute, report_hour, report_minute,
  engineering_hour, engineering_minute, updated_at
) VALUES (
  'platform', 'Europe/London', 16, 30, 17, 0, 17, 5, datetime('now')
);
