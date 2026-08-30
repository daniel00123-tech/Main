CREATE TABLE IF NOT EXISTS xero_oauth_log (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_callback_at TEXT,
  last_callback_ok INTEGER,
  last_error TEXT,
  last_has_code INTEGER,
  last_has_state INTEGER
);
