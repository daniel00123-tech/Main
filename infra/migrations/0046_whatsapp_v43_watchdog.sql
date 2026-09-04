-- WhatsApp V4.3 — independent watchdog receipts and per-chat lock TTL.
-- Incremental only. Do not replay 0025–0040.

ALTER TABLE whatsapp_inbound_events ADD COLUMN watchdog_5s_at TEXT;
ALTER TABLE whatsapp_inbound_events ADD COLUMN webhook_override_ok INTEGER;

CREATE TABLE IF NOT EXISTS whatsapp_chat_locks (
  chat_key TEXT PRIMARY KEY,
  wamid TEXT NOT NULL,
  locked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
