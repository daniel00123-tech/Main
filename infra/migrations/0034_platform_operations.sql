-- Platform operations heartbeats + query indexes for operator dashboards

CREATE TABLE IF NOT EXISTS platform_ops_heartbeats (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  last_run_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  detail_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_events_type_created
  ON audit_events(event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_automation_runs_status_started
  ON automation_runs(status, started_at)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS idx_microsoft_file_jobs_stale
  ON microsoft_file_jobs(status, updated_at)
  WHERE status IN ('processing', 'retrying', 'queued');

CREATE INDEX IF NOT EXISTS idx_financial_integrity_open
  ON financial_integrity_exceptions(status, company_id)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_microsoft_graph_subscriptions_expiry
  ON microsoft_graph_subscriptions(status, expires_at);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_errors
  ON stripe_webhook_events(received_at DESC)
  WHERE error_message IS NOT NULL;
