-- Full-text search index for hybrid knowledge retrieval (lexical + semantic)

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
  content,
  title,
  external_id,
  filename,
  heading,
  section,
  project,
  company,
  category,
  document_type,
  source,
  chunk_id UNINDEXED,
  document_id UNINDEXED,
  chunk_index UNINDEXED,
  tokenize = 'porter unicode61'
);

INSERT INTO knowledge_chunks_fts (
  content,
  title,
  external_id,
  filename,
  heading,
  section,
  project,
  company,
  category,
  document_type,
  source,
  chunk_id,
  document_id,
  chunk_index
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
  COALESCE(json_extract(d.metadata, '$.sourceFormat'), ''),
  COALESCE(json_extract(d.metadata, '$.source'), ''),
  c.id,
  c.document_id,
  c.chunk_index
FROM knowledge_chunks c
INNER JOIN knowledge_documents d ON d.id = c.document_id
WHERE d.status = 'indexed';
