-- Company-scoped extract/chunk index on the control plane.
-- Used when a company Business MCP has no /admin/knowledge corpus (EL today).

CREATE TABLE IF NOT EXISTS company_knowledge_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  filename TEXT,
  title TEXT,
  mime_type TEXT,
  extraction_method TEXT,
  extracted_text TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  stored_item_id TEXT,
  stored_url TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (company_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_company_knowledge_documents_company
  ON company_knowledge_documents(company_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS company_knowledge_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL,
  document_id INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES company_knowledge_documents(id)
);

CREATE INDEX IF NOT EXISTS idx_company_knowledge_chunks_doc
  ON company_knowledge_chunks(company_id, document_id, chunk_index);
