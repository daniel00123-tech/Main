-- Outlook mailbox ingestion jobs — extend file job table for mail messages and attachments.

ALTER TABLE microsoft_file_jobs ADD COLUMN item_kind TEXT NOT NULL DEFAULT 'drive_file'
  CHECK(item_kind IN ('drive_file', 'mail_message', 'mail_attachment'));

ALTER TABLE microsoft_file_jobs ADD COLUMN parent_message_id TEXT;
ALTER TABLE microsoft_file_jobs ADD COLUMN attachment_id TEXT;

CREATE INDEX IF NOT EXISTS idx_microsoft_file_jobs_item_kind
  ON microsoft_file_jobs(company_id, source_id, item_kind, status);
