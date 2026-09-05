-- Per-mailbox folder coverage for Outlook attachment ingest.
-- Inbox is always included in code. Sent Items and Archive stay opt-in.
-- User-created folders are never auto-enabled.

CREATE TABLE IF NOT EXISTS company_mailbox_folder_settings (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  mailbox_address TEXT NOT NULL,
  include_sent INTEGER NOT NULL DEFAULT 0,
  include_archive INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (company_id, mailbox_address)
);

CREATE TABLE IF NOT EXISTS company_mailbox_ingest_folders (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  mailbox_address TEXT NOT NULL,
  folder_id TEXT,
  folder_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'seed',
  last_checkpoint TEXT,
  last_scan_at TEXT,
  last_messages_scanned INTEGER,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mailbox_ingest_folders_mailbox
  ON company_mailbox_ingest_folders(company_id, mailbox_address);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mailbox_ingest_folders_name
  ON company_mailbox_ingest_folders(company_id, mailbox_address, folder_name);
