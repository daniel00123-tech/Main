-- Document-level FTS for hierarchical stage-A retrieval + extended chunk FTS metadata

DROP TABLE IF EXISTS knowledge_chunks_fts;

CREATE VIRTUAL TABLE knowledge_chunks_fts USING fts5(
  content,
  title,
  external_id,
  filename,
  heading,
  section,
  project,
  company,
  category,
  topic,
  department,
  property,
  document_type,
  source,
  chunk_id UNINDEXED,
  document_id UNINDEXED,
  chunk_index UNINDEXED,
  tokenize = 'porter unicode61'
);

INSERT INTO knowledge_chunks_fts (
  content, title, external_id, filename, heading, section, project, company,
  category, topic, department, property, document_type, source,
  chunk_id, document_id, chunk_index
)
SELECT
  c.content,
  d.title,
  d.external_id,
  COALESCE(json_extract(d.metadata, '$.originalFilename'), ''),
  COALESCE(json_extract(c.metadata, '$.heading'), ''),
  COALESCE(json_extract(c.metadata, '$.section'), ''),
  COALESCE(json_extract(d.metadata, '$.project'), ''),
  COALESCE(json_extract(d.metadata, '$.company'), ''),
  COALESCE(json_extract(d.metadata, '$.category'), ''),
  COALESCE(json_extract(d.metadata, '$.topic'), ''),
  COALESCE(json_extract(d.metadata, '$.department'), ''),
  COALESCE(json_extract(d.metadata, '$.property'), ''),
  COALESCE(json_extract(d.metadata, '$.sourceFormat'), ''),
  COALESCE(json_extract(d.metadata, '$.source'), ''),
  c.id,
  c.document_id,
  c.chunk_index
FROM knowledge_chunks c
INNER JOIN knowledge_documents d ON d.id = c.document_id
WHERE d.status = 'indexed';

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_documents_fts USING fts5(
  title,
  filename,
  company,
  project,
  category,
  topic,
  department,
  property,
  person,
  customer,
  supplier,
  summary,
  document_type,
  source,
  document_id UNINDEXED,
  tokenize = 'porter unicode61'
);

INSERT INTO knowledge_documents_fts (
  title, filename, company, project, category, topic, department, property,
  person, customer, supplier, summary, document_type, source, document_id
)
SELECT
  d.title,
  COALESCE(json_extract(d.metadata, '$.originalFilename'), ''),
  COALESCE(json_extract(d.metadata, '$.company'), ''),
  COALESCE(json_extract(d.metadata, '$.project'), ''),
  COALESCE(json_extract(d.metadata, '$.category'), ''),
  COALESCE(json_extract(d.metadata, '$.topic'), ''),
  COALESCE(json_extract(d.metadata, '$.department'), ''),
  COALESCE(json_extract(d.metadata, '$.property'), ''),
  COALESCE(json_extract(d.metadata, '$.person'), ''),
  COALESCE(json_extract(d.metadata, '$.customer'), ''),
  COALESCE(json_extract(d.metadata, '$.supplier'), ''),
  COALESCE(
    (
      SELECT substr(content, 1, 600)
      FROM knowledge_chunks c0
      WHERE c0.document_id = d.id
      ORDER BY c0.chunk_index
      LIMIT 1
    ),
    ''
  ),
  COALESCE(json_extract(d.metadata, '$.sourceFormat'), ''),
  COALESCE(json_extract(d.metadata, '$.source'), ''),
  d.id
FROM knowledge_documents d
WHERE d.status = 'indexed';
