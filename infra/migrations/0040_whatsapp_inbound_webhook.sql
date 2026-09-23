-- WhatsApp production webhook inbox.
-- Stores inbound Meta payloads for background processing.
-- Does not enable outbound AI replies.

CREATE TABLE IF NOT EXISTS whatsapp_inbound_events (
  id TEXT PRIMARY KEY,
  wamid TEXT UNIQUE,
  phone_number_id TEXT,
  business_account_id TEXT,
  sender_e164 TEXT,
  message_type TEXT,
  identity_found INTEGER NOT NULL DEFAULT 0,
  user_id TEXT,
  company_id TEXT,
  signature_valid INTEGER,
  processed INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  error TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_inbound_received
  ON whatsapp_inbound_events(received_at DESC);

CREATE INDEX IF NOT EXISTS idx_whatsapp_inbound_sender
  ON whatsapp_inbound_events(sender_e164, received_at DESC);
