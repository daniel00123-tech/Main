import {
  NoSearchableContentError,
  RequiresManualReviewError,
  RequiresOcrError,
  extractDocument,
} from "./document-extract";
import {
  chunkSegments,
  parseSegmentMetadataJson,
  segmentMetadataToJson,
  segmentMetadataToVectorFields,
  type SegmentMetadata,
} from "./document-segments";
import { embedText } from "./knowledge-embed";
import {
  buildChunkSearchRecord,
  vectorMetadataFromRecord,
} from "./knowledge-metadata";
import { deleteDocumentFtsRows, insertChunkFtsRow } from "./knowledge-fts";
import {
  searchCompanyKnowledgeHybrid,
  type KnowledgeSearchOptions,
  type KnowledgeSearchResponse,
} from "./knowledge-search";
import type { Env } from "./db";
import { log } from "./logger";

export { embedText } from "./knowledge-embed";
export type {
  KnowledgeSearchOptions,
  KnowledgeSearchResponse,
  KnowledgeSearchResult,
  KnowledgeSearchDiagnostics,
  KnowledgeSearchRanking,
} from "./knowledge-search";

export async function searchCompanyKnowledge(
  env: Env,
  query: string,
  topK = 5,
  options?: Omit<KnowledgeSearchOptions, "topK">
): Promise<KnowledgeSearchResponse> {
  return searchCompanyKnowledgeHybrid(env, query, {
    ...options,
    topK,
  });
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
    "SELECT id, chunk_index, content, vector_id, token_estimate, metadata FROM knowledge_chunks WHERE document_id = ? ORDER BY chunk_index"
  )
    .bind(doc.id)
    .all();

  const importHistory = await env.CADDINGTON_BUSINESS_DATA.prepare(
    "SELECT id, operation, status, started_at, completed_at, chunks_processed, error_message FROM knowledge_import_log WHERE document_id = ? ORDER BY started_at DESC LIMIT 10"
  )
    .bind(doc.id)
    .all();

  const normalizedChunks = chunks.results.map((row) => {
    const record = row as Record<string, unknown>;
    const metadata = parseSegmentMetadataJson(
      record.metadata as string | null | undefined
    );
    return {
      ...record,
      metadata: Object.keys(metadata).length > 0 ? metadata : null,
    };
  });

  return {
    document: doc,
    chunks: normalizedChunks,
    importHistory: importHistory.results,
  };
}

async function mergeDocumentMetadata(
  env: Env,
  documentId: number,
  patch: Record<string, unknown>
): Promise<void> {
  const row = await env.CADDINGTON_BUSINESS_DATA.prepare(
    "SELECT metadata FROM knowledge_documents WHERE id = ?"
  )
    .bind(documentId)
    .first<{ metadata: string | null }>();

  let base: Record<string, unknown> = {};
  if (row?.metadata) {
    try {
      base = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      base = {};
    }
  }

  const merged = { ...base, ...patch };
  await env.CADDINGTON_BUSINESS_DATA.prepare(
    "UPDATE knowledge_documents SET metadata = ?, updated_at = datetime('now') WHERE id = ?"
  )
    .bind(JSON.stringify(merged), documentId)
    .run();
}

function isTerminalIndexingError(error: unknown): boolean {
  return (
    error instanceof RequiresOcrError ||
    error instanceof NoSearchableContentError ||
    error instanceof RequiresManualReviewError
  );
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
    "SELECT id, external_id, title, r2_key, mime_type, status, metadata FROM knowledge_documents WHERE id = ?"
  )
    .bind(documentId)
    .first<{
      id: number;
      external_id: string;
      title: string;
      r2_key: string;
      mime_type: string | null;
      status: string;
      metadata: string | null;
    }>();

  if (!doc) throw new Error(`Document ${documentId} not found.`);

  const logId = await startKnowledgeImportLog(env, documentId, "index");

  try {
    const object = await env.CADDINGTON_KNOWLEDGE.get(doc.r2_key);
    if (!object) {
      throw new Error(`Storage object missing for key: ${doc.r2_key}`);
    }

    const bytes = await object.arrayBuffer();
    const extracted = await extractDocument(
      env,
      bytes,
      doc.mime_type ?? object.httpMetadata?.contentType ?? "text/plain",
      doc.r2_key
    );

    const documentMetaPatch: Record<string, unknown> = {
      sourceFormat: extracted.format,
      rawTextLength: extracted.rawTextLength,
    };

    if (extracted.format === "image") {
      documentMetaPatch.extractionMethod = extracted.extractionMethod;
      documentMetaPatch.visionModel = extracted.visionModel;
      documentMetaPatch.visionStatus = extracted.visionStatus;
      documentMetaPatch.fileType = extracted.fileType;
      documentMetaPatch.mimeType = extracted.mimeType;
      if (extracted.imageDimensions) {
        documentMetaPatch.imageWidth = extracted.imageDimensions.width;
        documentMetaPatch.imageHeight = extracted.imageDimensions.height;
      }
    }

    await mergeDocumentMetadata(env, documentId, documentMetaPatch);

    if (extracted.requiresOcr) {
      await env.CADDINGTON_BUSINESS_DATA.prepare(
        `UPDATE knowledge_documents SET status = 'requires_ocr', updated_at = datetime('now') WHERE id = ?`
      )
        .bind(documentId)
        .run();
      await mergeDocumentMetadata(env, documentId, {
        requiresOcr: true,
        requiresOcrReason:
          "Insufficient extractable text from PDF; OCR is required before indexing.",
      });
      const ocrMessage =
        "PDF has little or no extractable text. Document marked as requires_ocr.";
      await completeKnowledgeImportLog(env, logId, "failed", 0, ocrMessage);
      throw new RequiresOcrError(ocrMessage);
    }

    if (extracted.imageContentStatus === "no_searchable_content") {
      await env.CADDINGTON_BUSINESS_DATA.prepare(
        `UPDATE knowledge_documents SET status = 'no_searchable_content', updated_at = datetime('now') WHERE id = ?`
      )
        .bind(documentId)
        .run();
      await mergeDocumentMetadata(env, documentId, {
        imageReviewReason:
          "No searchable text or description could be extracted from the image.",
      });
      const message =
        "Image has no searchable content. Document marked as no_searchable_content.";
      await completeKnowledgeImportLog(env, logId, "failed", 0, message);
      throw new NoSearchableContentError(message);
    }

    if (extracted.imageContentStatus === "requires_manual_review") {
      await env.CADDINGTON_BUSINESS_DATA.prepare(
        `UPDATE knowledge_documents SET status = 'requires_manual_review', updated_at = datetime('now') WHERE id = ?`
      )
        .bind(documentId)
        .run();
      await mergeDocumentMetadata(env, documentId, {
        imageReviewReason:
          "Insufficient extractable content from image for reliable semantic search.",
        extractedPreview: extracted.segments
          .map((s) => s.text)
          .join("\n")
          .slice(0, 500),
      });
      const message =
        "Image has insufficient searchable content. Document marked as requires_manual_review.";
      await completeKnowledgeImportLog(env, logId, "failed", 0, message);
      throw new RequiresManualReviewError(message);
    }

    const chunks = chunkSegments(extracted.segments);
    if (chunks.length === 0) {
      throw new Error("No extractable text in document.");
    }

    await env.CADDINGTON_BUSINESS_DATA.prepare(
      "DELETE FROM knowledge_chunks WHERE document_id = ?"
    )
      .bind(documentId)
      .run();
    await deleteDocumentFtsRows(env, documentId);

    const refreshedDoc = await env.CADDINGTON_BUSINESS_DATA.prepare(
      "SELECT id, external_id, title, r2_key, mime_type, metadata FROM knowledge_documents WHERE id = ?"
    )
      .bind(documentId)
      .first<{
        id: number;
        external_id: string;
        title: string;
        r2_key: string;
        mime_type: string | null;
        metadata: string | null;
      }>();

    const docForIndexing = refreshedDoc ?? doc;
    const vectors: VectorizeVector[] = [];
    let indexed = 0;

    for (let i = 0; i < chunks.length; i++) {
      const { content, metadata } = chunks[i];
      const chunkMetadata: SegmentMetadata = {
        ...metadata,
        chunkNumber: i,
      };
      const vectorId = `${doc.external_id}-chunk-${i}`;
      const embedding = await embedText(env, content);
      const metadataJson = segmentMetadataToJson(chunkMetadata);

      const insert = await env.CADDINGTON_BUSINESS_DATA.prepare(
        `INSERT INTO knowledge_chunks (document_id, chunk_index, content, vector_id, token_estimate, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(
          documentId,
          i,
          content,
          vectorId,
          Math.ceil(content.length / 4),
          metadataJson === "{}" ? null : metadataJson
        )
        .run();

      const chunkId = insert.meta.last_row_id;
      const searchRecord = buildChunkSearchRecord(
        {
          id: chunkId,
          document_id: documentId,
          chunk_index: i,
          content,
          metadata: metadataJson === "{}" ? null : metadataJson,
        },
        docForIndexing
      );

      await insertChunkFtsRow(env, searchRecord);

      vectors.push({
        id: vectorId,
        values: embedding,
        metadata: {
          ...vectorMetadataFromRecord(searchRecord),
          ...segmentMetadataToVectorFields(chunkMetadata),
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
      format: extracted.format,
      chunks: indexed,
    });

    return { chunksIndexed: indexed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isTerminalIndexingError(error)) {
      await env.CADDINGTON_BUSINESS_DATA.prepare(
        `UPDATE knowledge_documents SET status = 'failed', updated_at = datetime('now') WHERE id = ?`
      )
        .bind(documentId)
        .run();
      await completeKnowledgeImportLog(env, logId, "failed", 0, message);
    }
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
