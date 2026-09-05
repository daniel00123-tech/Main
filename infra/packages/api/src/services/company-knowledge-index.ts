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

/** Short business prefixes / generic words. Downweighted; excluded from first-stage SQL when a distinctive token exists. */
const GENERIC_BUSINESS_TOKENS = new Set([
  "inv",
  "po",
  "job",
  "wo",
  "so",
  "ref",
  "doc",
  "id",
  "num",
  "quote",
  "order",
  "file",
  "pdf",
  "docx",
  "xlsx",
  "csv",
  "invoice",
  "invoices",
  "document",
  "documents",
]);

export type KnowledgeTokenClass = "high" | "medium" | "low";

export type ClassifiedKnowledgeToken = {
  token: string;
  cls: KnowledgeTokenClass;
  weight: number;
};

export type ClassifiedKnowledgeQuery = {
  original: string;
  normalized: string;
  compact: string;
  references: string[];
  tokens: ClassifiedKnowledgeToken[];
  highValueTokens: string[];
  firstStageTokens: string[];
  broadTokens: string[];
};

type KnowledgeCandidateRow = {
  document_id: number;
  filename: string | null;
  title: string | null;
  stored_url: string | null;
  external_id: string | null;
  metadata_json: string | null;
  text: string;
  chunk_index: number;
};

function compactAlnum(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sanitizeLikeNeedle(value: string): string {
  return value.toLowerCase().replace(/[%_]/g, "").trim();
}

function filenameStem(value: string): string {
  return value.toLowerCase().replace(/\.[a-z0-9]{2,5}$/i, "");
}

function classifyRawToken(token: string): KnowledgeTokenClass {
  if (!token) return "low";
  if (GENERIC_BUSINESS_TOKENS.has(token) || KNOWLEDGE_SEARCH_STOPWORDS.has(token)) return "low";
  if (/\d{4,}/.test(token) || /[a-z]/.test(token) && /\d/.test(token)) return "high";
  if (token.length >= 8) return "high";
  if (token.length >= 5) return "medium";
  if (token.length <= 3) return "low";
  return "medium";
}

function tokenWeight(cls: KnowledgeTokenClass): number {
  if (cls === "high") return 5;
  if (cls === "medium") return 2;
  return 0.4;
}

function addUnique(list: string[], value: string): void {
  const next = sanitizeLikeNeedle(value);
  if (next.length < 3 || list.includes(next)) return;
  list.push(next);
}

export function classifyKnowledgeQuery(query: string): ClassifiedKnowledgeQuery {
  const original = query.trim();
  const normalized = original.toLowerCase().replace(/[_/]+/g, "-").replace(/\s+/g, " ").trim();
  const compact = compactAlnum(original);
  const references: string[] = [];

  for (const match of normalized.match(/\b[a-z]{1,8}[-][a-z0-9]{3,}\b/g) ?? []) {
    addUnique(references, match);
    addUnique(references, compactAlnum(match));
  }
  for (const match of compact.match(/[a-z]{2,6}\d{4,}/g) ?? []) {
    addUnique(references, match);
    const split = match.match(/^([a-z]{2,6})(\d{4,})$/);
    if (split?.[1] && split[2]) addUnique(references, `${split[1]}-${split[2]}`);
  }

  const looseTokens = normalized
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);

  const letterTokens = looseTokens.filter((token) => /^[a-z]{2,6}$/.test(token) && !KNOWLEDGE_SEARCH_STOPWORDS.has(token));
  const digitTokens = looseTokens.filter((token) => /^\d{4,}$/.test(token));
  for (const prefix of letterTokens) {
    for (const digits of digitTokens) {
      addUnique(references, `${prefix}-${digits}`);
      addUnique(references, `${prefix}${digits}`);
    }
  }

  const tokenMap = new Map<string, ClassifiedKnowledgeToken>();
  const consider = (raw: string) => {
    const token = sanitizeLikeNeedle(raw);
    if (token.length < 3 || KNOWLEDGE_SEARCH_STOPWORDS.has(token)) return;
    const cls = classifyRawToken(token);
    const existing = tokenMap.get(token);
    if (!existing || tokenWeight(cls) > existing.weight) {
      tokenMap.set(token, { token, cls, weight: tokenWeight(cls) });
    }
  };
  for (const token of looseTokens) consider(token);
  for (const match of compact.match(/[a-z]{2,6}\d{4,}/g) ?? []) {
    const split = match.match(/^([a-z]{2,6})(\d{4,})$/);
    if (split?.[1]) consider(split[1]);
    if (split?.[2]) consider(split[2]);
  }
  for (const token of digitTokens) consider(token);

  const tokens = [...tokenMap.values()].sort(
    (left, right) => right.weight - left.weight || right.token.length - left.token.length || left.token.localeCompare(right.token),
  );
  const highValueTokens = tokens.filter((row) => row.cls === "high").map((row) => row.token);
  const firstStageTokens = highValueTokens.length
    ? highValueTokens
    : tokens.filter((row) => row.cls !== "low").map((row) => row.token);
  const broadTokens = highValueTokens.length
    ? tokens.filter((row) => row.cls === "medium").map((row) => row.token)
    : tokens.map((row) => row.token);

  return {
    original,
    normalized,
    compact,
    references,
    tokens,
    highValueTokens,
    firstStageTokens: firstStageTokens.length ? firstStageTokens : tokens.map((row) => row.token),
    broadTokens: broadTokens.length ? broadTokens : firstStageTokens,
  };
}

export function knowledgeSearchTokens(query: string): string[] {
  const classified = classifyKnowledgeQuery(query);
  const ordered = [
    ...classified.highValueTokens,
    ...classified.tokens.filter((row) => row.cls !== "high").map((row) => row.token),
  ];
  return [...new Set(ordered)].slice(0, 6);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function tokenPresent(haystack: string, token: string): boolean {
  const needle = sanitizeLikeNeedle(token);
  if (!needle) return false;
  const text = haystack.toLowerCase();
  if (/^\d{4,}$/.test(needle) || (/[a-z]/.test(needle) && /\d/.test(needle))) {
    return text.includes(needle) || compactAlnum(text).includes(compactAlnum(needle));
  }
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}([^a-z0-9]|$)`, "i").test(text);
}

function scoreKnowledgeCandidate(row: KnowledgeCandidateRow, classified: ClassifiedKnowledgeQuery): number {
  const filename = (row.filename ?? "").toLowerCase();
  const title = (row.title ?? "").toLowerCase();
  const heading = `${title} ${filename}`.trim();
  const stem = filenameStem(filename);
  const titleStem = filenameStem(title);
  const compactHeading = compactAlnum(`${title} ${filename}`);
  const text = (row.text ?? "").toLowerCase();
  const meta = `${row.external_id ?? ""} ${row.metadata_json ?? ""}`.toLowerCase();
  const query = classified.normalized;
  const queryStem = filenameStem(query);
  let score = 0;

  if (query && (filename === query || title === query || stem === queryStem || titleStem === queryStem)) score += 240;
  if (query.length >= 4 && (filename.includes(query) || title.includes(query) || stem.includes(queryStem))) score += 140;
  if (classified.compact.length >= 6 && compactHeading.includes(classified.compact)) score += 120;

  for (const reference of classified.references) {
    const compactRef = compactAlnum(reference);
    if (filename.includes(reference) || title.includes(reference) || stem.includes(reference)) score += 160;
    else if (compactRef.length >= 5 && compactHeading.includes(compactRef)) score += 130;
    if (text.includes(reference) || (compactRef.length >= 5 && compactAlnum(text).includes(compactRef))) score += 45;
    if (meta.includes(reference) || (compactRef.length >= 5 && compactAlnum(meta).includes(compactRef))) score += 50;
  }

  let highHits = 0;
  let mediumHits = 0;
  let lowHits = 0;
  for (const token of classified.tokens) {
    const inHeading = tokenPresent(heading, token.token);
    const inBody = tokenPresent(text, token.token) || tokenPresent(meta, token.token);
    if (inHeading) {
      score += token.cls === "high" ? 28 * token.weight : 10 * token.weight;
      if (token.cls === "high") highHits += 1;
      if (token.cls === "medium") mediumHits += 1;
      if (token.cls === "low") lowHits += 1;
    } else if (inBody) {
      score += token.cls === "high" ? 8 * token.weight : 2 * token.weight;
      if (token.cls === "high") highHits += 1;
      if (token.cls === "medium") mediumHits += 1;
      if (token.cls === "low") lowHits += 1;
    }
  }
  if (highHits > 0 && lowHits > 0) score += 30;
  return score;
}

export function knowledgeHitMatchesQuery(
  hit: { title?: unknown; filename?: unknown; snippet?: unknown; text?: unknown },
  query: string,
): boolean {
  const classified = classifyKnowledgeQuery(query);
  const haystack = `${hit.title ?? ""} ${hit.filename ?? ""} ${hit.snippet ?? ""} ${hit.text ?? ""}`;
  if (classified.references.some((reference) => tokenPresent(haystack, reference) || compactAlnum(haystack).includes(compactAlnum(reference)))) {
    return true;
  }
  const heading = `${hit.title ?? ""} ${hit.filename ?? ""}`;
  const headingDistinct = classified.tokens.filter((token) => token.cls !== "low" && tokenPresent(heading, token.token));
  if (headingDistinct.length >= 2) return true;
  if (classified.highValueTokens.length) {
    const identifiers = classified.highValueTokens.filter((token) => /\d/.test(token));
    if (identifiers.length) {
      return identifiers.some((token) => tokenPresent(haystack, token));
    }
    return classified.highValueTokens.some((token) => tokenPresent(haystack, token));
  }
  const medium = classified.tokens.filter((token) => token.cls === "medium");
  if (medium.length >= 2) {
    return medium.filter((token) => tokenPresent(haystack, token.token)).length >= 2;
  }
  return classified.tokens.some((token) => tokenPresent(haystack, token.token));
}

function keepScoredCandidate(
  score: number,
  row: KnowledgeCandidateRow,
  classified: ClassifiedKnowledgeQuery,
): boolean {
  if (score <= 0) return false;
  return knowledgeHitMatchesQuery(
    { title: row.title, filename: row.filename, text: row.text },
    classified.original,
  );
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

export function logicalKnowledgeDocumentKey(input: {
  id?: string | number | null;
  documentId?: string | number | null;
  title?: string | null;
  filename?: string | null;
}): string {
  const heading = filenameStem(String(input.filename || input.title || ""))
    .replace(/__[a-f0-9]{6,}(?=$)/i, "")
    .trim();
  const compact = compactAlnum(heading);
  return compact || String(input.id ?? input.documentId ?? "").toLowerCase();
}

export function mergeKnowledgeSearchHits<
  T extends {
    id?: string;
    documentId?: string | number | null;
    title?: string;
    filename?: string;
    provenance?: Array<Record<string, unknown>>;
  },
>(local: T[], remote: T[]): T[] {
  const seen = new Map<string, T>();
  const merged: T[] = [];
  for (const hit of [...local, ...remote]) {
    const logical = logicalKnowledgeDocumentKey(hit);
    const key = logical || `${String(hit.id ?? hit.documentId ?? "").toLowerCase()}|${String(hit.title ?? "").toLowerCase()}`;
    const existing = seen.get(key);
    if (existing) {
      const extra = {
        id: hit.id ?? hit.documentId ?? null,
        title: hit.title ?? null,
        filename: hit.filename ?? null,
      };
      const provenance = Array.isArray(existing.provenance) ? existing.provenance : [];
      if (!provenance.some((row) => String(row.id ?? "") === String(extra.id ?? "") && String(row.title ?? "") === String(extra.title ?? ""))) {
        existing.provenance = [...provenance, extra];
      }
      continue;
    }
    seen.set(key, hit);
    merged.push(hit);
  }
  return merged;
}

function likeNeedles(values: string[]): string[] {
  return [...new Set(values.map(sanitizeLikeNeedle).filter((value) => value.length >= 3))].slice(0, 6);
}

async function fetchKnowledgeCandidatePool(
  env: Env,
  companyId: string,
  needles: string[],
  limit: number,
): Promise<KnowledgeCandidateRow[]> {
  const terms = likeNeedles(needles);
  if (!terms.length || limit <= 0) return [];
  const fieldClause = `(
    LOWER(COALESCE(d.filename, '')) LIKE ?
    OR LOWER(COALESCE(d.title, '')) LIKE ?
    OR LOWER(COALESCE(d.external_id, '')) LIKE ?
    OR LOWER(COALESCE(d.metadata_json, '')) LIKE ?
    OR LOWER(c.text) LIKE ?
  )`;
  const sql = `SELECT d.id AS document_id, d.filename, d.title, d.stored_url, d.external_id, d.metadata_json, c.text, c.chunk_index
     FROM company_knowledge_chunks c
     JOIN company_knowledge_documents d ON d.id = c.document_id
     WHERE d.company_id = ?
       AND (${terms.map(() => fieldClause).join(" OR ")})
     LIMIT ?`;
  const binds: Array<string | number> = [companyId];
  for (const term of terms) {
    const like = `%${term}%`;
    binds.push(like, like, like, like, like);
  }
  binds.push(limit);
  const rows = await env.DB.prepare(sql).bind(...binds).all<KnowledgeCandidateRow>();
  return rows.results ?? [];
}

export async function searchCompanyKnowledgeIndex(
  env: Env,
  input: { companyId: string; query: string; limit?: number },
): Promise<Array<Record<string, unknown>>> {
  await ensureCompanyKnowledgeIndexSchema(env.DB);
  const classified = classifyKnowledgeQuery(input.query);
  if (!classified.tokens.length && !classified.references.length) return [];

  const exactNeedles = likeNeedles([
    classified.normalized,
    filenameStem(classified.normalized),
    classified.compact,
    ...classified.references,
    ...classified.highValueTokens,
  ]);
  const distinctiveNeedles = likeNeedles(classified.highValueTokens);
  const broadNeedles = likeNeedles(classified.broadTokens);

  const exactRows = await fetchKnowledgeCandidatePool(env, input.companyId, exactNeedles, 40);
  const distinctiveRows = distinctiveNeedles.length
    ? await fetchKnowledgeCandidatePool(env, input.companyId, distinctiveNeedles, 40)
    : [];
  const needBroad = classified.highValueTokens.length === 0;
  const broadRows = needBroad ? await fetchKnowledgeCandidatePool(env, input.companyId, broadNeedles, 80) : [];

  const merged = [...exactRows, ...distinctiveRows, ...broadRows];
  const bestByDoc = new Map<number, { row: KnowledgeCandidateRow; score: number }>();
  for (const row of merged) {
    const score = scoreKnowledgeCandidate(row, classified);
    if (!keepScoredCandidate(score, row, classified)) continue;
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
