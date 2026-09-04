-- Tenant mailbox attachment-ingestion policy.
-- default_policy applies to newly discovered company mailboxes.
-- Explicit overrides INCLUDE / EXCLUDE / INHERIT_DEFAULT a mailbox or user.

CREATE TABLE IF NOT EXISTS company_mailbox_ingestion_policies (
  company_id TEXT PRIMARY KEY,
  default_policy TEXT NOT NULL DEFAULT 'EXCLUDE'
    CHECK(default_policy IN ('INCLUDE', 'EXCLUDE')),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE TABLE IF NOT EXISTS company_mailbox_ingestion_overrides (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  mailbox_id TEXT,
  mailbox_address TEXT,
  display_name TEXT,
  policy TEXT NOT NULL
    CHECK(policy IN ('INHERIT_DEFAULT', 'INCLUDE', 'EXCLUDE')),
  reason TEXT,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE INDEX IF NOT EXISTS idx_mailbox_ingest_overrides_company
  ON company_mailbox_ingestion_overrides(company_id);
