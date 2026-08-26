-- Phase 2: MCP execution metering and allowlist foundation

-- Extend usage_records for commercial-ready metering (null-safe costs)
ALTER TABLE usage_records ADD COLUMN user_id TEXT;
ALTER TABLE usage_records ADD COLUMN actor_email TEXT;
ALTER TABLE usage_records ADD COLUMN mcp_environment_id TEXT;
ALTER TABLE usage_records ADD COLUMN connector_instance_id TEXT;
ALTER TABLE usage_records ADD COLUMN tool_name TEXT;
ALTER TABLE usage_records ADD COLUMN action TEXT;
ALTER TABLE usage_records ADD COLUMN risk_class TEXT;
ALTER TABLE usage_records ADD COLUMN success INTEGER NOT NULL DEFAULT 1;
ALTER TABLE usage_records ADD COLUMN duration_ms INTEGER;
ALTER TABLE usage_records ADD COLUMN source_client TEXT;
ALTER TABLE usage_records ADD COLUMN correlation_id TEXT;
ALTER TABLE usage_records ADD COLUMN underlying_cost_cents INTEGER;
ALTER TABLE usage_records ADD COLUMN customer_charge_cents INTEGER;

CREATE INDEX IF NOT EXISTS idx_usage_records_company_recorded
  ON usage_records(company_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_usage_records_correlation
  ON usage_records(correlation_id);

-- Company-scoped allowlist of MCP tools that INFRA may invoke
CREATE TABLE IF NOT EXISTS mcp_tool_allowlist (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  mcp_environment_id TEXT NOT NULL REFERENCES mcp_environments(id),
  tool_name TEXT NOT NULL,
  risk_class TEXT NOT NULL DEFAULT 'low_risk',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(mcp_environment_id, tool_name)
);

CREATE INDEX IF NOT EXISTS idx_mcp_tool_allowlist_mcp
  ON mcp_tool_allowlist(mcp_environment_id);

-- Optional sync/knowledge summary cache for company portal (metadata only)
ALTER TABLE mcp_environments ADD COLUMN last_successful_request_at TEXT;
ALTER TABLE mcp_environments ADD COLUMN last_error TEXT;
ALTER TABLE mcp_environments ADD COLUMN last_latency_ms INTEGER;
ALTER TABLE mcp_environments ADD COLUMN knowledge_document_count INTEGER;
ALTER TABLE mcp_environments ADD COLUMN knowledge_chunk_count INTEGER;
ALTER TABLE mcp_environments ADD COLUMN last_sync_at TEXT;
