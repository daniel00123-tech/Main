-- Microsoft Graph change-notification subscriptions and per-company tenant binding.

ALTER TABLE connector_instances ADD COLUMN microsoft_tenant_id TEXT;

CREATE TABLE IF NOT EXISTS microsoft_graph_subscriptions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  connector_instance_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  graph_subscription_id TEXT,
  resource_path TEXT NOT NULL,
  notification_url TEXT NOT NULL,
  client_state TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'active', 'expired', 'failed')),
  last_notification_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (source_id) REFERENCES microsoft_connector_sources(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_microsoft_graph_sub_source
  ON microsoft_graph_subscriptions(source_id);

CREATE INDEX IF NOT EXISTS idx_microsoft_graph_sub_expires
  ON microsoft_graph_subscriptions(status, expires_at);
