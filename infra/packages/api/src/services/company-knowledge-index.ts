/**
 * Control-plane extract/chunk index for companies whose Business MCP
 * does not expose /admin/knowledge (EL today). Caddington stays on MCP admin.
 */

import type { Env } from "../env";
import { nowIso } from "../db/mappers";
import { chunkExtractedText, extractDocumentBytes } from "./document-text-extract";

export async function ensureCompanyKnowledgeIndexSchema(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS company_knowledge_documents (
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
      )`,
    )
    .run();
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS company_knowledge_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id TEXT NOT NULL,
        document_id INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
    )
    .run();
}

export function shouldUseLocalCompanyKnowledgeIndex(mcp: {
  serviceBindingRef?: string | null;
}): boolean {
  return (mcp.serviceBindingRef ?? "") === "EL_BUSINESS_MCP";
}

export async function indexExtractedDocumentLocally(
  env: Env,
  input: {
    companyId: string;
    externalId: string;
    filename: string;
    title: string;
    mimeType: string | null;
    bytes: ArrayBuffer;
    storedItemId?: string | null;
    storedUrl?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<
  | {
      ok: true;
      documentId: number;
      indexed: boolean;
      chunksIndexed: number;
      extractionMethod: string;
      documentStatus: string;
    }
  | { ok: false; code: string; message: string }
> {
  await ensureCompanyKnowledgeIndexSchema(env.DB);
  const extracted = await extractDocumentBytes(env, {
    bytes: input.bytes,
    filename: input.filename,
    mimeType: input.mimeType,
  });
  if (!extracted.text.trim()) {
    return {
      ok: false,
      code: "KNOWLEDGE_EXTRACT_EMPTY",
      message: `No extractable text (${extracted.method})`,
    };
  }
  const now = nowIso();
  const existing = await env.DB.prepare(
    `SELECT id FROM company_knowledge_documents WHERE company_id = ? AND external_id = ? LIMIT 1`,
  )
    .bind(input.companyId, input.externalId)
    .first<{ id: number }>();

  let documentId = existing?.id ?? 0;
  const text = extracted.text.slice(0, 120_000);
  if (existing?.id) {
    await env.DB.prepare(
      `UPDATE company_knowledge_documents
       SET filename = ?, title = ?, mime_type = ?, extraction_method = ?, extracted_text = ?,
           stored_item_id = COALESCE(?, stored_item_id), stored_url = COALESCE(?, stored_url),
           metadata_json = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        input.filename,
        input.title,
        input.mimeType,
        extracted.method,
        text,
        input.storedItemId ?? null,
        input.storedUrl ?? null,
        JSON.stringify(input.metadata ?? {}),
        now,
        existing.id,
      )
      .run();
    await env.DB.prepare(`DELETE FROM company_knowledge_chunks WHERE document_id = ?`).bind(existing.id).run();
  } else {
    const inserted = await env.DB.prepare(
      `INSERT INTO company_knowledge_documents (
        company_id, external_id, filename, title, mime_type, extraction_method, extracted_text,
        chunk_count, stored_item_id, stored_url, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    )
      .bind(
        input.companyId,
        input.externalId,
        input.filename,
        input.title,
        input.mimeType,
        extracted.method,
        text,
        input.storedItemId ?? null,
        input.storedUrl ?? null,
        JSON.stringify(input.metadata ?? {}),
        now,
        now,
      )
      .run();
    documentId = Number(inserted.meta.last_row_id ?? 0);
    if (!documentId) {
      const row = await env.DB.prepare(
        `SELECT id FROM company_knowledge_documents WHERE company_id = ? AND external_id = ? LIMIT 1`,
      )
        .bind(input.companyId, input.externalId)
        .first<{ id: number }>();
      documentId = row?.id ?? 0;
    }
  }
  if (!documentId) {
    return { ok: false, code: "KNOWLEDGE_INDEX_WRITE_FAILED", message: "Document row was not persisted" };
  }

  const chunks = chunkExtractedText(String(documentId), text);
  if (!chunks.length) {
    return { ok: false, code: "KNOWLEDGE_EXTRACT_EMPTY", message: "Extracted text did not produce chunks" };
  }
  for (const chunk of chunks) {
    await env.DB.prepare(
      `INSERT INTO company_knowledge_chunks (company_id, document_id, chunk_index, text, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(input.companyId, documentId, chunk.index, chunk.text.slice(0, 4000), now)
      .run();
  }
  await env.DB.prepare(`UPDATE company_knowledge_documents SET chunk_count = ?, updated_at = ? WHERE id = ?`)
    .bind(chunks.length, now, documentId)
    .run();

  return {
    ok: true,
    documentId,
    indexed: true,
    chunksIndexed: chunks.length,
    extractionMethod: extracted.method,
    documentStatus: "indexed",
  };
}

export async function searchCompanyKnowledgeIndex(
  env: Env,
  input: { companyId: string; query: string; limit?: number },
): Promise<Array<Record<string, unknown>>> {
  await ensureCompanyKnowledgeIndexSchema(env.DB);
  const tokens = input.query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3)
    .slice(0, 6);
  if (!tokens.length) return [];
  const like = `%${tokens[0]}%`;
  const rows = await env.DB.prepare(
    `SELECT d.id AS document_id, d.filename, d.title, d.stored_url, c.text, c.chunk_index
     FROM company_knowledge_chunks c
     JOIN company_knowledge_documents d ON d.id = c.document_id
     WHERE d.company_id = ?
       AND (
         LOWER(COALESCE(d.filename, '')) LIKE ?
         OR LOWER(COALESCE(d.title, '')) LIKE ?
         OR LOWER(c.text) LIKE ?
       )
     ORDER BY c.chunk_index ASC
     LIMIT ?`,
  )
    .bind(input.companyId, like, like, like, Math.min(20, Math.max(1, input.limit ?? 8)))
    .all<{
      document_id: number;
      filename: string | null;
      title: string | null;
      stored_url: string | null;
      text: string;
      chunk_index: number;
    }>();

  const seen = new Set<number>();
  const hits: Array<Record<string, unknown>> = [];
  for (const row of rows.results ?? []) {
    if (seen.has(row.document_id)) continue;
    seen.add(row.document_id);
    hits.push({
      title: row.title || row.filename,
      documentId: row.document_id,
      document_id: row.document_id,
      filename: row.filename,
      category: "outlook_attachments",
      source: "knowledge_intake",
      snippet: row.text.slice(0, 160),
      topic: "outlook",
      url: row.stored_url,
    });
  }
  return hits;
}
