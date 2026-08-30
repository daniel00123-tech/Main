-- Reference knowledge schema for Business MCP Core company MCPs.
-- FTS and Vectorize bindings are configured per company worker.

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  r2_key TEXT NOT NULL,
  mime_type TEXT,
  byte_size INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN (
      'pending',
      'indexed',
      'failed',
      'requires_ocr',
      'requires_manual_review',
      'no_searchable_content'
    )
  ),
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  indexed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_documents_external
  ON knowledge_documents (external_id);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES knowledge_documents (id),
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  vector_id TEXT,
  token_estimate INTEGER,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (document_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS knowledge_import_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER REFERENCES knowledge_documents (id),
  operation TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  chunks_indexed INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  metadata TEXT
);

-- Company workers should add FTS5 virtual tables in separate migrations
-- (see Caddington migrations 0004/0005 as reference implementation).
