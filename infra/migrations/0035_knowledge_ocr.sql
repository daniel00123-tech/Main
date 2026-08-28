-- Azure Document Intelligence OCR V1 — job/idempotency + usage indexes

CREATE TABLE IF NOT EXISTS knowledge_ocr_jobs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  knowledge_document_id INTEGER NOT NULL,
  content_fingerprint TEXT NOT NULL,
  mime_type TEXT,
  title TEXT,
  ocr_provider TEXT NOT NULL,
  ocr_model TEXT NOT NULL,
  ocr_api_version TEXT NOT NULL,
  ocr_status TEXT NOT NULL,
  ocr_page_count INTEGER,
  ocr_completed_at TEXT,
  ocr_attempt_count INTEGER NOT NULL DEFAULT 0,
  ocr_failure_category TEXT,
  duration_ms INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (company_id, knowledge_document_id, content_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_ocr_jobs_company_status
  ON knowledge_ocr_jobs(company_id, ocr_status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_knowledge_ocr_jobs_document
  ON knowledge_ocr_jobs(knowledge_document_id, updated_at DESC);
