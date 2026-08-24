import { EMBEDDING_MODEL } from "./constants";
import { extractDocumentText } from "./document-extract";
import type { Env } from "./db";
import { log } from "./logger";

const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 120;

export interface KnowledgeSearchResult {
  documentId: number;
  externalId: string;
  title: string;
  chunkId: number;
  chunkIndex: number;
  score: number;
  snippet: string;
}

export async function embedText(env: Env, text: string): Promise<number[]> {
  const response = await env.AI.run(EMBEDDING_MODEL, { text });
  const data = (response as { data?: number[][] }).data;
  if (!data?.[0]) {
    throw new Error("Embedding model returned no vectors.");
  }
  return data[0];
}

export function chunkText(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(start + CHUNK_SIZE, normalized.length);
    chunks.push(normalized.slice(start, end).trim());
    if (end >= normalized.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return chunks.filter((c) => c.length > 0);
}

export async function searchCompanyKnowledge(
  env: Env,
  query: string,
  topK = 5
): Promise<KnowledgeSearchResult[]> {
  if (!env.CADDINGTON_KNOWLEDGE_INDEX) {
    throw new Error(
      "Vectorize index is not available. Enable Vectorize and redeploy with bindings."
    );
  }
  const vector = await embedText(env, query);
  const matches = await env.CADDINGTON_KNOWLEDGE_INDEX.query(vector, {
    topK,
    returnMetadata: "all",
  });

  const results: KnowledgeSearchResult[] = [];
  for (const match of matches.matches) {
    const meta = match.metadata ?? {};
    const documentId = Number(meta.document_id ?? 0);
    const chunkId = Number(meta.chunk_id ?? 0);
    const chunkIndex = Number(meta.chunk_index ?? 0);
    const externalId = String(meta.external_id ?? "");
    const title = String(meta.title ?? "");

    let snippet = String(meta.snippet ?? "");
    if (!snippet && chunkId > 0) {
      const row = await env.CADDINGTON_BUSINESS_DATA.prepare(
        "SELECT content FROM knowledge_chunks WHERE id = ?"
      )
        .bind(chunkId)
        .first<{ content: string }>();
      snippet = row?.content?.slice(0, 280) ?? "";
    }

    results.push({
      documentId,
      externalId,
      title,
      chunkId,
      chunkIndex,
      score: match.score ?? 0,
      snippet,
    });
  }

  return results;
}

export async function getKnowledgeDocument(
  env: Env,
  documentRef: string
): Promise<Record<string, unknown> | null> {
  const isNumeric = /^\d+$/.test(documentRef);
  const doc = isNumeric
    ? await env.CADDINGTON_BUSINESS_DATA.prepare(
        "SELECT * FROM knowledge_documents WHERE id = ?"
      )
        .bind(Number(documentRef))
        .first<Record<string, unknown>>()
    : await env.CADDINGTON_BUSINESS_DATA.prepare(
        "SELECT * FROM knowledge_documents WHERE external_id = ?"
      )
        .bind(documentRef)
        .first<Record<string, unknown>>();

  if (!doc) return null;

  const chunks = await env.CADDINGTON_BUSINESS_DATA.prepare(
    "SELECT id, chunk_index, content, vector_id, token_estimate FROM knowledge_chunks WHERE document_id = ? ORDER BY chunk_index"
  )
    .bind(doc.id)
    .all();

  const importHistory = await env.CADDINGTON_BUSINESS_DATA.prepare(
    "SELECT id, operation, status, started_at, completed_at, chunks_processed, error_message FROM knowledge_import_log WHERE document_id = ? ORDER BY started_at DESC LIMIT 10"
  )
    .bind(doc.id)
    .all();

  return {
    document: doc,
    chunks: chunks.results,
    importHistory: importHistory.results,
  };
}

export async function indexKnowledgeDocument(
  env: Env,
  documentId: number
): Promise<{ chunksIndexed: number }> {
  if (!env.CADDINGTON_KNOWLEDGE || !env.CADDINGTON_KNOWLEDGE_INDEX) {
    throw new Error(
      "R2 and Vectorize bindings are required for indexing. Enable account resources and redeploy."
    );
  }
  const doc = await env.CADDINGTON_BUSINESS_DATA.prepare(
    "SELECT id, external_id, title, r2_key, mime_type, status FROM knowledge_documents WHERE id = ?"
  )
    .bind(documentId)
    .first<{
      id: number;
      external_id: string;
      title: string;
      r2_key: string;
      mime_type: string | null;
      status: string;
    }>();

  if (!doc) throw new Error(`Document ${documentId} not found.`);

  const logId = await startKnowledgeImportLog(env, documentId, "index");

  try {
    const object = await env.CADDINGTON_KNOWLEDGE.get(doc.r2_key);
    if (!object) {
      throw new Error(`Storage object missing for key: ${doc.r2_key}`);
    }

    const bytes = await object.arrayBuffer();
    const text = await extractDocumentText(
      env,
      bytes,
      doc.mime_type ?? object.httpMetadata?.contentType ?? "text/plain",
      doc.r2_key
    );
    const chunks = chunkText(text);
    if (chunks.length === 0) throw new Error("No extractable text in document.");

    await env.CADDINGTON_BUSINESS_DATA.prepare(
      "DELETE FROM knowledge_chunks WHERE document_id = ?"
    )
      .bind(documentId)
      .run();

    const vectors: VectorizeVector[] = [];
    let indexed = 0;

    for (let i = 0; i < chunks.length; i++) {
      const content = chunks[i];
      const vectorId = `${doc.external_id}-chunk-${i}`;
      const embedding = await embedText(env, content);

      const insert = await env.CADDINGTON_BUSINESS_DATA.prepare(
        `INSERT INTO knowledge_chunks (document_id, chunk_index, content, vector_id, token_estimate)
         VALUES (?, ?, ?, ?, ?)`
      )
        .bind(documentId, i, content, vectorId, Math.ceil(content.length / 4))
        .run();

      const chunkId = insert.meta.last_row_id;
      vectors.push({
        id: vectorId,
        values: embedding,
        metadata: {
          document_id: String(documentId),
          chunk_id: String(chunkId),
          chunk_index: String(i),
          external_id: doc.external_id,
          title: doc.title,
          snippet: content.slice(0, 280),
        },
      });
      indexed++;
    }

    if (vectors.length > 0) {
      await env.CADDINGTON_KNOWLEDGE_INDEX.upsert(vectors);
    }

    await env.CADDINGTON_BUSINESS_DATA.prepare(
      `UPDATE knowledge_documents SET status = 'indexed', indexed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    )
      .bind(documentId)
      .run();

    await completeKnowledgeImportLog(env, logId, "completed", indexed);
    log("info", "knowledge_document_indexed", {
      documentId,
      chunks: indexed,
    });

    return { chunksIndexed: indexed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.CADDINGTON_BUSINESS_DATA.prepare(
      `UPDATE knowledge_documents SET status = 'failed', updated_at = datetime('now') WHERE id = ?`
    )
      .bind(documentId)
      .run();
    await completeKnowledgeImportLog(env, logId, "failed", 0, message);
    throw error;
  }
}

async function startKnowledgeImportLog(
  env: Env,
  documentId: number,
  operation: string
): Promise<number> {
  const result = await env.CADDINGTON_BUSINESS_DATA.prepare(
    `INSERT INTO knowledge_import_log (document_id, operation, status) VALUES (?, ?, 'started')`
  )
    .bind(documentId, operation)
    .run();
  return Number(result.meta.last_row_id);
}

async function completeKnowledgeImportLog(
  env: Env,
  logId: number,
  status: string,
  chunksProcessed: number,
  errorMessage?: string
): Promise<void> {
  await env.CADDINGTON_BUSINESS_DATA.prepare(
    `UPDATE knowledge_import_log SET status = ?, completed_at = datetime('now'), chunks_processed = ?, error_message = ? WHERE id = ?`
  )
    .bind(status, chunksProcessed, errorMessage ?? null, logId)
    .run();
}
