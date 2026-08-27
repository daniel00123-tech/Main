-- INFRA Automation Engine V1 — multi-tenant scheduled and manual automations.

CREATE TABLE IF NOT EXISTS automation_definitions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft', 'active', 'paused', 'disabled', 'error')),
  trigger_type TEXT NOT NULL DEFAULT 'schedule'
    CHECK(trigger_type IN ('schedule', 'manual', 'webhook', 'connector_event', 'data_change', 'threshold', 'email_received', 'crm_event')),
  schedule_json TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  action_type TEXT NOT NULL
    CHECK(action_type IN ('ai_prompt', 'mcp_tool', 'internal')),
  configuration_json TEXT NOT NULL,
  service_identity_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_run_at TEXT,
  next_run_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  maximum_retries INTEGER NOT NULL DEFAULT 3,
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  automation_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  trigger_type TEXT NOT NULL,
  idempotency_key TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  initiated_by TEXT,
  started_at TEXT,
  completed_at TEXT,
  duration_ms INTEGER,
  result_summary TEXT,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (automation_id) REFERENCES automation_definitions(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_idempotency
  ON automation_runs(automation_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_automation_runs_company
  ON automation_runs(company_id, automation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS automation_run_steps (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_index INTEGER NOT NULL DEFAULT 0,
  action_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued', 'running', 'completed', 'failed', 'skipped')),
  started_at TEXT,
  completed_at TEXT,
  result_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (run_id) REFERENCES automation_runs(id)
);

CREATE TABLE IF NOT EXISTS automation_events (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  automation_id TEXT,
  run_id TEXT,
  event_type TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE INDEX IF NOT EXISTS idx_automation_definitions_due
  ON automation_definitions(status, next_run_at)
  WHERE status = 'active' AND trigger_type = 'schedule';

CREATE INDEX IF NOT EXISTS idx_automation_definitions_company
  ON automation_definitions(company_id, status, updated_at DESC);
