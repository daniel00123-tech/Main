-- WhatsApp V4.4 — post-ack search completion, independent 15/30/60 watchdog, latency, circuit.
-- Incremental only. Do not replay 0025–0040.

ALTER TABLE whatsapp_inbound_events ADD COLUMN user_stage TEXT;
ALTER TABLE whatsapp_inbound_events ADD COLUMN progress_sent_at TEXT;
ALTER TABLE whatsapp_inbound_events ADD COLUMN delay_sent_at TEXT;
ALTER TABLE whatsapp_inbound_events ADD COLUMN watchdog_15s_at TEXT;
ALTER TABLE whatsapp_inbound_events ADD COLUMN watchdog_60s_at TEXT;
ALTER TABLE whatsapp_inbound_events ADD COLUMN planning_ms INTEGER;
ALTER TABLE whatsapp_inbound_events ADD COLUMN queue_ms INTEGER;
ALTER TABLE whatsapp_inbound_events ADD COLUMN mcp_ms INTEGER;
ALTER TABLE whatsapp_inbound_events ADD COLUMN knowledge_search_ms INTEGER;
ALTER TABLE whatsapp_inbound_events ADD COLUMN fetch_ms INTEGER;
ALTER TABLE whatsapp_inbound_events ADD COLUMN synthesis_ms INTEGER;
ALTER TABLE whatsapp_inbound_events ADD COLUMN outbound_ms INTEGER;
ALTER TABLE whatsapp_inbound_events ADD COLUMN total_ms INTEGER;
ALTER TABLE whatsapp_inbound_events ADD COLUMN slowest_stage TEXT;

CREATE TABLE IF NOT EXISTS whatsapp_knowledge_circuit (
  company_id TEXT PRIMARY KEY,
  consecutive_timeouts INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'closed',
  opened_at TEXT,
  cooldown_until TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
