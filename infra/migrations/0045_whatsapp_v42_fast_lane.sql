-- WhatsApp V4.2 — webhook receipts, outbound delivery evidence, persist errors.
-- Incremental only. Do not replay 0025–0040.

ALTER TABLE whatsapp_inbound_events ADD COLUMN persist_ok INTEGER;
ALTER TABLE whatsapp_inbound_events ADD COLUMN persist_error TEXT;
ALTER TABLE whatsapp_inbound_events ADD COLUMN webhook_status INTEGER;
ALTER TABLE whatsapp_inbound_events ADD COLUMN fast_lane INTEGER;
ALTER TABLE whatsapp_inbound_events ADD COLUMN outbound_http_status INTEGER;
ALTER TABLE whatsapp_inbound_events ADD COLUMN outbound_meta_message_id TEXT;
ALTER TABLE whatsapp_inbound_events ADD COLUMN outbound_attempts INTEGER;
ALTER TABLE whatsapp_inbound_events ADD COLUMN watchdog_10s_at TEXT;
ALTER TABLE whatsapp_inbound_events ADD COLUMN watchdog_30s_at TEXT;
ALTER TABLE whatsapp_inbound_events ADD COLUMN dlq_at TEXT;
ALTER TABLE whatsapp_inbound_events ADD COLUMN signature_error TEXT;
