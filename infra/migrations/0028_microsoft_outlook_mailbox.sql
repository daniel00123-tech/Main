-- Outlook shared mailbox READ alpha — mailbox classification and mail webhook subscriptions.

ALTER TABLE microsoft_connector_sources ADD COLUMN mailbox_type TEXT
  CHECK(mailbox_type IN ('shared_mailbox', 'personal_mailbox', 'room_mailbox', 'equipment_mailbox', 'unknown'));

ALTER TABLE microsoft_graph_subscriptions ADD COLUMN resource_kind TEXT NOT NULL DEFAULT 'drive'
  CHECK(resource_kind IN ('drive', 'mailbox'));

CREATE INDEX IF NOT EXISTS idx_microsoft_sources_outlook_mailbox
  ON microsoft_connector_sources(company_id, source_type, mailbox_address)
  WHERE source_type = 'outlook_shared';
