-- Additive: encrypted connector credential store (ciphertext only).
-- Wrapping keys stay in Worker secrets, never in D1.

CREATE TABLE IF NOT EXISTS secret_ciphertexts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  connector_instance_id TEXT,
  purpose TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  key_version TEXT NOT NULL,
  nonce_b64 TEXT NOT NULL,
  ciphertext_b64 TEXT NOT NULL,
  aad TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  predecessor_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rotated_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_secret_ciphertexts_company
  ON secret_ciphertexts(company_id, status);

CREATE TABLE IF NOT EXISTS secret_ciphertext_history (
  id TEXT PRIMARY KEY,
  secret_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  key_version TEXT NOT NULL,
  nonce_b64 TEXT NOT NULL,
  ciphertext_b64 TEXT NOT NULL,
  aad TEXT NOT NULL,
  retired_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_secret_ciphertext_history_secret
  ON secret_ciphertext_history(secret_id);
