-- Full-capability Xero: execution plans + connector scope tier metadata.
-- Additive only. No plaintext credentials.

CREATE TABLE IF NOT EXISTS execution_plans (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  connector_instance_id TEXT,
  provider TEXT NOT NULL DEFAULT 'xero',
  requested_action TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT,
  actor TEXT NOT NULL,
  correlation_id TEXT,
  interaction_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  proposed_changes_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  required_approval INTEGER NOT NULL DEFAULT 0,
  approval_status TEXT,
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  executed_at TEXT,
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_plans_idempotency
  ON execution_plans(company_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_execution_plans_company_status
  ON execution_plans(company_id, status, created_at DESC);
