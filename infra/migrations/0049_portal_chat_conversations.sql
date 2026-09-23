-- Portal Chat V1: first-party company conversations in infra-web.
-- Per user + company. No cross-tenant history.

CREATE TABLE IF NOT EXISTS portal_conversations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'New chat',
  context_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_portal_conversations_user_company
  ON portal_conversations (company_id, user_id, updated_at);

CREATE TABLE IF NOT EXISTS portal_conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES portal_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_portal_messages_conversation
  ON portal_conversation_messages (conversation_id, created_at);
