-- WhatsApp V4.5 — entity-bound interactive button contexts. Incremental only.

CREATE TABLE IF NOT EXISTS whatsapp_interaction_contexts (
  interaction_context_id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  company_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  conversation_id TEXT,
  source_message_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  title TEXT,
  source_system TEXT,
  source_url TEXT,
  excerpt TEXT,
  search_id TEXT,
  result_id TEXT,
  provider_item_id TEXT,
  source_key TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_interaction_ctx_token
  ON whatsapp_interaction_contexts (token);

CREATE INDEX IF NOT EXISTS idx_wa_interaction_ctx_scope
  ON whatsapp_interaction_contexts (company_id, user_id, expires_at);

CREATE TABLE IF NOT EXISTS whatsapp_button_idempotency (
  wamid TEXT NOT NULL,
  context_token TEXT NOT NULL,
  action TEXT NOT NULL,
  reply TEXT,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (wamid, context_token, action)
);
