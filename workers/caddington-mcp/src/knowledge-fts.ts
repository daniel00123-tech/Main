import type { Env } from "./db";
import type { ChunkSearchRecord } from "./knowledge-metadata";
import { buildChunkSearchRecord } from "./knowledge-metadata";
import { buildFtsMatchQuery, parseSearchQuery } from "./knowledge-query";

export interface LexicalSearchHit {
  chunkId: number;
  documentId: number;
  chunkIndex: number;
  bm25: number;
}

export async function deleteDocumentFtsRows(
  env: Env,
  documentId: number
): Promise<void> {
  await env.CADDINGTON_BUSINESS_DATA.prepare(
    "DELETE FROM knowledge_chunks_fts WHERE document_id = ?"
  )
    .bind(documentId)
    .run();
}

export async function insertChunkFtsRow(
  env: Env,
  record: ChunkSearchRecord
): Promise<void> {
  await env.CADDINGTON_BUSINESS_DATA.prepare(
    `INSERT INTO knowledge_chunks_fts (
      content, title, external_id, filename, heading, section, project, company,
      category, document_type, source, chunk_id, document_id, chunk_index
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      record.content,
      record.title,
      record.externalId,
      record.filename,
      record.heading,
      record.section,
      record.project,
      record.company,
      record.category,
      record.documentType,
      record.source,
      record.chunkId,
      record.documentId,
      record.chunkIndex
    )
    .run();
}

export async function lexicalSearchChunks(
  env: Env,
  ftsQuery: string,
  allowedDocumentIds: number[] | null,
  limit: number
): Promise<LexicalSearchHit[]> {
  if (!ftsQuery) return [];

  try {
    if (allowedDocumentIds && allowedDocumentIds.length === 0) return [];

    if (allowedDocumentIds && allowedDocumentIds.length > 0) {
      const placeholders = allowedDocumentIds.map(() => "?").join(",");
      const rows = await env.CADDINGTON_BUSINESS_DATA.prepare(
        `SELECT chunk_id, document_id, chunk_index, bm25(knowledge_chunks_fts) AS bm25
         FROM knowledge_chunks_fts
         WHERE knowledge_chunks_fts MATCH ?
           AND document_id IN (${placeholders})
         ORDER BY bm25
         LIMIT ?`
      )
        .bind(ftsQuery, ...allowedDocumentIds, limit)
        .all();

      return rows.results.map((row) => ({
        chunkId: Number((row as Record<string, unknown>).chunk_id),
        documentId: Number((row as Record<string, unknown>).document_id),
        chunkIndex: Number((row as Record<string, unknown>).chunk_index),
        bm25: Number((row as Record<string, unknown>).bm25 ?? 0),
      }));
    }

    const rows = await env.CADDINGTON_BUSINESS_DATA.prepare(
      `SELECT chunk_id, document_id, chunk_index, bm25(knowledge_chunks_fts) AS bm25
       FROM knowledge_chunks_fts
       WHERE knowledge_chunks_fts MATCH ?
       ORDER BY bm25
       LIMIT ?`
    )
      .bind(ftsQuery, limit)
      .all();

    return rows.results.map((row) => ({
      chunkId: Number((row as Record<string, unknown>).chunk_id),
      documentId: Number((row as Record<string, unknown>).document_id),
      chunkIndex: Number((row as Record<string, unknown>).chunk_index),
      bm25: Number((row as Record<string, unknown>).bm25 ?? 0),
    }));
  } catch {
    return [];
  }
}

export async function loadChunkSearchRecords(
  env: Env,
  chunkIds: number[]
): Promise<Map<number, ChunkSearchRecord>> {
  const map = new Map<number, ChunkSearchRecord>();
  if (chunkIds.length === 0) return map;

  const placeholders = chunkIds.map(() => "?").join(",");
  const rows = await env.CADDINGTON_BUSINESS_DATA.prepare(
    `SELECT c.id, c.document_id, c.chunk_index, c.content, c.metadata,
            d.external_id, d.title, d.r2_key, d.mime_type, d.metadata AS document_metadata
     FROM knowledge_chunks c
     INNER JOIN knowledge_documents d ON d.id = c.document_id
     WHERE c.id IN (${placeholders})`
  )
    .bind(...chunkIds)
    .all();

  for (const row of rows.results) {
    const record = row as Record<string, unknown>;
    const chunkRecord = buildChunkSearchRecord(
      {
        id: Number(record.id),
        document_id: Number(record.document_id),
        chunk_index: Number(record.chunk_index),
        content: String(record.content),
        metadata: record.metadata as string | null,
      },
      {
        external_id: String(record.external_id),
        title: String(record.title),
        r2_key: String(record.r2_key),
        mime_type: record.mime_type as string | null,
        metadata: record.document_metadata as string | null,
      }
    );
    map.set(chunkRecord.chunkId, chunkRecord);
  }

  return map;
}

export async function loadNeighbourChunkContent(
  env: Env,
  documentId: number,
  chunkIndex: number
): Promise<{ before?: string; after?: string }> {
  const before = await env.CADDINGTON_BUSINESS_DATA.prepare(
    "SELECT content FROM knowledge_chunks WHERE document_id = ? AND chunk_index = ?"
  )
    .bind(documentId, chunkIndex - 1)
    .first<{ content: string }>();

  const after = await env.CADDINGTON_BUSINESS_DATA.prepare(
    "SELECT content FROM knowledge_chunks WHERE document_id = ? AND chunk_index = ?"
  )
    .bind(documentId, chunkIndex + 1)
    .first<{ content: string }>();

  return {
    before: before?.content,
    after: after?.content,
  };
}
