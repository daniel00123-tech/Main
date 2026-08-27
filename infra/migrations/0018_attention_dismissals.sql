-- Platform attention dismissals (info/warning only; critical items cannot be permanently hidden)
CREATE TABLE IF NOT EXISTS attention_dismissals (
  id TEXT PRIMARY KEY,
  attention_key TEXT NOT NULL,
  dismissed_by TEXT NOT NULL,
  dismissed_at TEXT NOT NULL,
  snooze_until TEXT,
  UNIQUE (attention_key, dismissed_by)
);

CREATE INDEX IF NOT EXISTS idx_attention_dismissals_key ON attention_dismissals (attention_key);
