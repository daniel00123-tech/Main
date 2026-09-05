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

const KNOWLEDGE_SEARCH_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "was",
  "were",
  "this",
  "that",
  "with",
  "from",
  "have",
  "has",
  "what",
  "when",
  "does",
  "did",
  "how",
  "should",
  "about",
  "into",
  "your",
  "our",
  "any",
  "already",
  "indexed",
  "search",
  "company",
  "knowledge",
  "document",
  "documents",
  "tell",
  "there",
  "cover",
  "covers",
  "according",
  "guidance",
  "find",
  "look",
  "which",
  "where",
  "then",
  "than",
  "them",
  "they",
  "you",
  "can",
  "could",
  "please",
  "say",
  "says",
  "said",
]);

export function knowledgeSearchTokens(query: string): string[] {
  const raw = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !KNOWLEDGE_SEARCH_STOPWORDS.has(token));
  return [...new Set(raw)].sort((left, right) => right.length - left.length || left.localeCompare(right)).slice(0, 6);
}

function scoreKnowledgeRow(
  row: { title: string | null; filename: string | null; text: string },
  tokens: string[],
): number {
  const title = `${row.title ?? ""} ${row.filename ?? ""}`.toLowerCase();
  const text = (row.text ?? "").toLowerCase();
  return tokens.reduce((score, token) => {
    if (title.includes(token)) return score + 5;
    if (text.includes(token)) return score + 1;
    return score;
  }, 0);
}

export function localKnowledgeHitsToResults(
  hits: Array<Record<string, unknown>>,
): Array<{ id: string; title: string; url: string; snippet: string }> {
  return hits.map((hit) => ({
    id: String(hit.documentId ?? hit.document_id ?? ""),
    title: String(hit.title ?? hit.filename ?? "Untitled"),
    url: String(hit.url ?? hit.stored_url ?? ""),
    snippet: String(hit.snippet ?? ""),
  }));
}

export function mergeKnowledgeSearchHits<T extends { id?: string; title?: string }>(
  local: T[],
  remote: T[],
): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const hit of [...local, ...remote]) {
    const key = `${String(hit.id ?? "").toLowerCase()}|${String(hit.title ?? "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(hit);
  }
  return merged;
}

export async function searchCompanyKnowledgeIndex(
  env: Env,
  input: { companyId: string; query: string; limit?: number },
): Promise<Array<Record<string, unknown>>> {
  await ensureCompanyKnowledgeIndexSchema(env.DB);
  const tokens = knowledgeSearchTokens(input.query);
  if (!tokens.length) return [];
  const primary = `%${tokens[0]}%`;
  const secondary = `%${tokens[1] ?? tokens[0]}%`;
  const rows = await env.DB.prepare(
    `SELECT d.id AS document_id, d.filename, d.title, d.stored_url, c.text, c.chunk_index
     FROM company_knowledge_chunks c
     JOIN company_knowledge_documents d ON d.id = c.document_id
     WHERE d.company_id = ?
       AND (
         LOWER(COALESCE(d.filename, '')) LIKE ? OR LOWER(COALESCE(d.title, '')) LIKE ? OR LOWER(c.text) LIKE ?
         OR LOWER(COALESCE(d.filename, '')) LIKE ? OR LOWER(COALESCE(d.title, '')) LIKE ? OR LOWER(c.text) LIKE ?
       )
     LIMIT 80`,
  )
    .bind(input.companyId, primary, primary, primary, secondary, secondary, secondary)
    .all<{
      document_id: number;
      filename: string | null;
      title: string | null;
      stored_url: string | null;
      text: string;
      chunk_index: number;
    }>();

  const bestByDoc = new Map<number, { row: (typeof rows.results)[number]; score: number }>();
  for (const row of rows.results ?? []) {
    const score = scoreKnowledgeRow(row, tokens);
    if (score <= 0) continue;
    const existing = bestByDoc.get(row.document_id);
    if (!existing || score > existing.score) bestByDoc.set(row.document_id, { row, score });
  }
  return [...bestByDoc.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.min(20, Math.max(1, input.limit ?? 8)))
    .map(({ row }) => ({
      title: row.title || row.filename,
      documentId: row.document_id,
      document_id: row.document_id,
      filename: row.filename,
      category: "outlook_attachments",
      source: "knowledge_intake",
      snippet: row.text.slice(0, 160),
      topic: "outlook",
      url: row.stored_url,
    }));
}

export async function getCompanyKnowledgeDocument(
  env: Env,
  input: { companyId: string; documentId?: string | number | null; title?: string | null },
): Promise<{
  id: string;
  title: string;
  url: string;
  text: string;
  chunks: Array<{ id: string; heading: string; text: string }>;
} | null> {
  await ensureCompanyKnowledgeIndexSchema(env.DB);
  const numericId = Number(input.documentId);
  const titleNeedle = String(input.title ?? "").trim();
  const row = Number.isFinite(numericId) && numericId > 0
    ? await env.DB.prepare(
        `SELECT id, title, filename, stored_url, extracted_text
         FROM company_knowledge_documents
         WHERE company_id = ? AND id = ?
         LIMIT 1`,
      )
        .bind(input.companyId, numericId)
        .first<{ id: number; title: string | null; filename: string | null; stored_url: string | null; extracted_text: string | null }>()
    : titleNeedle
      ? await env.DB.prepare(
          `SELECT id, title, filename, stored_url, extracted_text
           FROM company_knowledge_documents
           WHERE company_id = ?
             AND (
               LOWER(COALESCE(title, '')) LIKE ?
               OR LOWER(COALESCE(filename, '')) LIKE ?
             )
           ORDER BY updated_at DESC
           LIMIT 1`,
        )
          .bind(input.companyId, `%${titleNeedle.toLowerCase()}%`, `%${titleNeedle.toLowerCase()}%`)
          .first<{ id: number; title: string | null; filename: string | null; stored_url: string | null; extracted_text: string | null }>()
      : null;
  if (!row) return null;
  const chunks = await env.DB.prepare(
    `SELECT chunk_index, text FROM company_knowledge_chunks
     WHERE company_id = ? AND document_id = ?
     ORDER BY chunk_index ASC LIMIT 8`,
  )
    .bind(input.companyId, row.id)
    .all<{ chunk_index: number; text: string }>();
  const text = String(row.extracted_text ?? "") || (chunks.results ?? []).map((chunk) => chunk.text).join("\n");
  if (!text.trim()) return null;
  return {
    id: String(row.id),
    title: row.title || row.filename || "Untitled",
    url: row.stored_url ?? "",
    text: text.slice(0, 8_000),
    chunks: (chunks.results ?? []).map((chunk) => ({
      id: `${row.id}:${chunk.chunk_index}`,
      heading: row.title || row.filename || "Untitled",
      text: chunk.text.slice(0, 700),
    })),
  };
}
