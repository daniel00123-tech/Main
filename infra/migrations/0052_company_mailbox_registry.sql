-- Tenant-aware mailbox registry.
-- Separates Outlook chat/search access from background attachment ingestion.
-- Future tenants configure approved mailboxes here; no hardcoded customer addresses.

CREATE TABLE IF NOT EXISTS company_mailbox_registry (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  mailbox_id TEXT,
  mailbox_address TEXT NOT NULL,
  mailbox_type TEXT NOT NULL
    CHECK(mailbox_type IN ('shared_mailbox', 'user_mailbox', 'personal_mailbox', 'service_mailbox', 'unknown')),
  display_name TEXT,
  enabled_for_mail_search INTEGER NOT NULL DEFAULT 0,
  enabled_for_attachment_ingestion INTEGER NOT NULL DEFAULT 0,
  sensitivity TEXT NOT NULL DEFAULT 'unspecified'
    CHECK(sensitivity IN ('company_operational', 'finance_operational', 'personal_work', 'unspecified')),
  status TEXT NOT NULL DEFAULT 'available'
    CHECK(status IN ('available', 'approved', 'denied', 'error')),
  graph_accessible INTEGER,
  last_checkpoint TEXT,
  last_successful_sync TEXT,
  last_attachment_scan_at TEXT,
  last_error TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  UNIQUE(company_id, mailbox_address)
);

CREATE INDEX IF NOT EXISTS idx_company_mailbox_registry_company
  ON company_mailbox_registry(company_id, enabled_for_attachment_ingestion);

CREATE INDEX IF NOT EXISTS idx_company_mailbox_registry_sync
  ON company_mailbox_registry(company_id, last_checkpoint);
