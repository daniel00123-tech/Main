-- Action Engine: extend execution_plans for confirmation, approval, stale-state, and audit.
-- Additive only. execution_plans remains the canonical store (ActionPlan alias).

ALTER TABLE execution_plans ADD COLUMN risk_class TEXT;
ALTER TABLE execution_plans ADD COLUMN source_client TEXT;
ALTER TABLE execution_plans ADD COLUMN permission_decision_json TEXT;
ALTER TABLE execution_plans ADD COLUMN financial_impact_json TEXT;
ALTER TABLE execution_plans ADD COLUMN confirmation_status TEXT DEFAULT 'not_required';
ALTER TABLE execution_plans ADD COLUMN confirmation_token_hash TEXT;
ALTER TABLE execution_plans ADD COLUMN confirmed_at TEXT;
ALTER TABLE execution_plans ADD COLUMN confirmed_by TEXT;
ALTER TABLE execution_plans ADD COLUMN plan_fingerprint TEXT;
ALTER TABLE execution_plans ADD COLUMN state_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE execution_plans ADD COLUMN expires_at TEXT;
ALTER TABLE execution_plans ADD COLUMN approval_required_by TEXT;

CREATE INDEX IF NOT EXISTS idx_execution_plans_company_expires
  ON execution_plans(company_id, expires_at)
  WHERE expires_at IS NOT NULL;
