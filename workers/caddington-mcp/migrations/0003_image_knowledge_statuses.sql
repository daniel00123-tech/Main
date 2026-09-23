-- Image ingestion statuses: requires_manual_review, no_searchable_content

PRAGMA foreign_keys = OFF;

CREATE TABLE knowledge_documents_new (
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

INSERT INTO knowledge_documents_new
SELECT id, external_id, title, description, r2_key, mime_type, byte_size, status, metadata, created_at, updated_at, indexed_at
FROM knowledge_documents;

CREATE TABLE knowledge_chunks_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  vector_id TEXT,
  token_estimate INTEGER,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (document_id, chunk_index)
);

INSERT INTO knowledge_chunks_new
SELECT id, document_id, chunk_index, content, vector_id, token_estimate, metadata, created_at
FROM knowledge_chunks;

CREATE TABLE knowledge_import_log_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER,
  operation TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  chunks_processed INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  metadata TEXT
);

INSERT INTO knowledge_import_log_new
SELECT id, document_id, operation, status, started_at, completed_at, chunks_processed, error_message, metadata
FROM knowledge_import_log;

DROP TABLE knowledge_import_log;
DROP TABLE knowledge_chunks;
DROP TABLE knowledge_documents;

ALTER TABLE knowledge_documents_new RENAME TO knowledge_documents;
ALTER TABLE knowledge_chunks_new RENAME TO knowledge_chunks;
ALTER TABLE knowledge_import_log_new RENAME TO knowledge_import_log;

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_documents_external ON knowledge_documents (external_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_status ON knowledge_documents (status);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document ON knowledge_chunks (document_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_import_log_document ON knowledge_import_log (document_id);

PRAGMA foreign_keys = ON;
