-- INFRA natural-language automation control V1.
-- Plans are validated specifications awaiting explicit confirmation.
-- Creating an automation stores configuration only — never executable code.

CREATE TABLE IF NOT EXISTS automation_control_plans (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  source TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  confirmation_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TEXT NOT NULL,
  consumed_automation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE INDEX IF NOT EXISTS idx_automation_control_plans_company
  ON automation_control_plans(company_id, created_at DESC);
