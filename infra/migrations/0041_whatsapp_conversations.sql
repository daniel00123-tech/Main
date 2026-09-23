CREATE TABLE IF NOT EXISTS whatsapp_conversations (
  user_id TEXT PRIMARY KEY,
  company_id TEXT,
  pending_company_selection INTEGER NOT NULL DEFAULT 0,
  turns_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_company
  ON whatsapp_conversations (company_id, updated_at);
