-- Durable action execution records for financial idempotency and verification evidence.
-- Additive only.

CREATE TABLE IF NOT EXISTS action_executions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL UNIQUE,
  company_id TEXT NOT NULL,
  execution_key TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'xero',
  requested_action TEXT NOT NULL,
  status TEXT NOT NULL,
  verification_status TEXT,
  xero_resource_id TEXT,
  human_reference TEXT,
  amount REAL,
  currency_code TEXT,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_action_executions_company_key
  ON action_executions(company_id, execution_key);

CREATE INDEX IF NOT EXISTS idx_action_executions_company_status
  ON action_executions(company_id, status, created_at DESC);
