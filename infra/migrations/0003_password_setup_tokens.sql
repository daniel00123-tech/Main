-- Single-use password setup / reset tokens

CREATE TABLE IF NOT EXISTS password_setup_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL DEFAULT 'password_setup',
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_password_setup_tokens_user ON password_setup_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_setup_tokens_hash ON password_setup_tokens(token_hash);
