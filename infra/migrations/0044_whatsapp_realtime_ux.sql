-- WhatsApp realtime UX V4.1 — incremental columns only. Do not replay 0025–0040.

ALTER TABLE whatsapp_inbound_events ADD COLUMN lifecycle_state TEXT;
ALTER TABLE whatsapp_inbound_events ADD COLUMN terminal_state TEXT;
ALTER TABLE whatsapp_inbound_events ADD COLUMN validated_at TEXT;
ALTER TABLE whatsapp_inbound_events ADD COLUMN acknowledged_at TEXT;
ALTER TABLE whatsapp_inbound_events ADD COLUMN planning_at TEXT;
ALTER TABLE whatsapp_inbound_events ADD COLUMN tool_running_at TEXT;
ALTER TABLE whatsapp_inbound_events ADD COLUMN synthesising_at TEXT;
ALTER TABLE whatsapp_inbound_events ADD COLUMN reply_sent_at TEXT;
ALTER TABLE whatsapp_inbound_events ADD COLUMN first_visible_at TEXT;
ALTER TABLE whatsapp_inbound_events ADD COLUMN last_error TEXT;
ALTER TABLE whatsapp_inbound_events ADD COLUMN identity_resolved_at TEXT;
ALTER TABLE whatsapp_inbound_events ADD COLUMN read_status_sent_at TEXT;
ALTER TABLE whatsapp_inbound_events ADD COLUMN typing_sent_at TEXT;
ALTER TABLE whatsapp_inbound_events ADD COLUMN acknowledgement_sent_at TEXT;
ALTER TABLE whatsapp_inbound_events ADD COLUMN final_sent_at TEXT;
ALTER TABLE whatsapp_inbound_events ADD COLUMN queue_accepted_at TEXT;
ALTER TABLE whatsapp_inbound_events ADD COLUMN recover_sent_at TEXT;
ALTER TABLE whatsapp_inbound_events ADD COLUMN time_to_first_visible_ms INTEGER;
ALTER TABLE whatsapp_inbound_events ADD COLUMN read_status_ok INTEGER;
ALTER TABLE whatsapp_inbound_events ADD COLUMN typing_ok INTEGER;
ALTER TABLE whatsapp_inbound_events ADD COLUMN ack_send_ok INTEGER;
ALTER TABLE whatsapp_inbound_events ADD COLUMN final_send_ok INTEGER;
ALTER TABLE whatsapp_inbound_events ADD COLUMN outbound_error TEXT;
ALTER TABLE whatsapp_inbound_events ADD COLUMN inbound_text TEXT;
