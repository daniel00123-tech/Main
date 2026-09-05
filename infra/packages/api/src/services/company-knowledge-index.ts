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
      code: extracted.failureCode ?? "KNOWLEDGE_EXTRACT_EMPTY",
      message: extracted.failureReason ?? `No extractable text (${extracted.method})`,
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

const WORKPLACE_SAFETY_SIGNALS = new Set([
  "accident",
  "accidents",
  "incident",
  "incidents",
  "injury",
  "injuries",
  "injured",
  "hurt",
  "emergency",
  "emergencies",
  "hazard",
  "hazards",
  "unsafe",
  "reportable",
  "firstaid",
]);

const PROCEDURE_ASK_WORDS = new Set(["process", "procedure", "policy", "guide", "guidance", "handbook"]);

const GENERIC_TOKEN_ALIASES: Record<string, string[]> = {
  admin: ["administration", "administrative"],
  administration: ["admin"],
  administrative: ["admin", "administration"],
  finance: ["financial"],
  financial: ["finance"],
  remit: ["remittance", "remittances"],
  remittance: ["remit", "remittances"],
  remittances: ["remittance", "remit"],
  payment: ["payments"],
  payments: ["payment"],
  booking: ["bookings", "book"],
  bookings: ["booking", "book"],
  book: ["booking", "bookings"],
  process: ["processes", "procedure", "procedures"],
  processes: ["process"],
  procedure: ["procedures", "process"],
  procedures: ["procedure", "process"],
  holiday: ["holidays"],
  holidays: ["holiday"],
  supplier: ["suppliers"],
  suppliers: ["supplier"],
  subcontractor: ["subcontractors"],
  subcontractors: ["subcontractor"],
};

export type KnowledgeConceptFamily = {
  id: "workplace_safety" | "process_procedure";
  expansionQueries: string[];
  documentNeedles: string[];
  titleAnchors: string[][];
};

function workplaceSafetyCompoundHits(tokens: Set<string>): boolean {
  const gasRelated =
    tokens.has("gas") &&
    (tokens.has("leak") ||
      tokens.has("leaks") ||
      tokens.has("leaking") ||
      tokens.has("smell") ||
      tokens.has("escape") ||
      tokens.has("odour") ||
      tokens.has("odor"));
  const dangerousOccurrence = tokens.has("dangerous") && tokens.has("occurrence");
  const unsafeCondition = tokens.has("unsafe") && (tokens.has("condition") || tokens.has("act") || tokens.has("situation"));
  const reportable =
    tokens.has("reportable") && (tokens.has("incident") || tokens.has("accident") || tokens.has("injury") || tokens.has("occurrence"));
  return gasRelated || dangerousOccurrence || unsafeCondition || reportable;
}

export function stemKnowledgeToken(token: string): string {
  const value = sanitizeLikeNeedle(token);
  if (value.length <= 4) return value;
  if (value.endsWith("ies") && value.length > 5) return `${value.slice(0, -3)}y`;
  if (value.endsWith("sses")) return value.slice(0, -2);
  if (value.endsWith("tions") && value.length > 8) return value.slice(0, -1);
  if (value.endsWith("ing") && value.length > 6) return value.slice(0, -3);
  if (value.endsWith("ers") && value.length > 6) return value.slice(0, -1);
  if (value.endsWith("s") && !value.endsWith("ss") && !value.endsWith("us") && !value.endsWith("is")) {
    return value.slice(0, -1);
  }
  return value;
}

export function expandLexicalVariants(token: string): string[] {
  const root = sanitizeLikeNeedle(token);
  if (root.length < 3) return root ? [root] : [];
  const variants = new Set<string>([root, stemKnowledgeToken(root)]);
  for (const alias of GENERIC_TOKEN_ALIASES[root] ?? []) {
    variants.add(alias);
    variants.add(stemKnowledgeToken(alias));
  }
  const stemmed = stemKnowledgeToken(root);
  for (const alias of GENERIC_TOKEN_ALIASES[stemmed] ?? []) {
    variants.add(alias);
    variants.add(stemKnowledgeToken(alias));
  }
  return [...variants].filter((item) => item.length >= 3);
}

function isCalendarYearToken(token: string): boolean {
  return /^(19|20)\d{2}$/.test(token);
}

function isDocumentIdentifierToken(token: string): boolean {
  if (!token) return false;
  if (isCalendarYearToken(token)) return false;
  if (/[a-z]/.test(token) && /\d/.test(token)) return true;
  return /^\d{5,}$/.test(token);
}

export function detectKnowledgeConceptFamily(query: string): KnowledgeConceptFamily | null {
  const classified = classifyKnowledgeQuery(query);
  const tokens = new Set(classified.tokens.map((row) => row.token));
  for (const part of classified.normalized.split(/[^a-z0-9]+/)) {
    if (part) tokens.add(part);
  }
  for (const part of normalizeKnowledgeHeading(query).split(/\s+/)) {
    if (part) tokens.add(part);
  }
  const hasSafetySignal =
    [...WORKPLACE_SAFETY_SIGNALS].some((signal) => tokens.has(signal)) ||
    workplaceSafetyCompoundHits(tokens) ||
    classified.compact.includes("firstaid");
  if (hasSafetySignal) {
    return {
      id: "workplace_safety",
      expansionQueries: ["health and safety policy", "workplace accident incident emergency injury"],
      documentNeedles: ["health", "safety", "incident", "emergency", "accident", "hazard", "injury", "gas"],
      titleAnchors: [["health", "safety"], ["accident"], ["incident"], ["emergency"], ["injury"], ["occurrence"]],
    };
  }
  const procedureAsk =
    /\b(process|procedure|policy|how do (?:we|i|you)|how should|what (?:is|does|should))\b/i.test(classified.original);
  const distinctive = classified.tokens.filter(
    (row) =>
      row.cls !== "low" &&
      !PROCEDURE_ASK_WORDS.has(row.token) &&
      !GENERIC_BUSINESS_TOKENS.has(row.token),
  );
  if (!procedureAsk || !distinctive.length) return null;
  const needles = [
    ...distinctive.flatMap((row) => expandLexicalVariants(row.token)),
    "process",
    "procedure",
    "policy",
    "guide",
    "advice",
  ];
  return {
    id: "process_procedure",
    expansionQueries: [],
    documentNeedles: [...new Set(needles)].filter((item) => item.length >= 4).slice(0, 8),
    titleAnchors: distinctive.map((row) => [stemKnowledgeToken(row.token)]),
  };
}

export function knowledgeConceptExpansionQueries(query: string): string[] {
  return detectKnowledgeConceptFamily(query)?.expansionQueries ?? [];
}

export function looksLikePolicyOrProcedureHeading(heading: string): boolean {
  return /\b(policy|procedure|process|guidance|handbook|guide|advice|form|knowledge base|code of conduct)\b/i.test(
    heading,
  );
}

export function hitMatchesKnowledgeConceptFamily(
  hit: { title?: unknown; filename?: unknown; snippet?: unknown; text?: unknown },
  query: string,
): boolean {
  const family = detectKnowledgeConceptFamily(query);
  if (!family) return false;
  const heading = `${hit.title ?? ""} ${hit.filename ?? ""}`;
  return family.titleAnchors.some((anchor) => anchor.every((token) => tokenPresent(heading, token)));
}

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

/** Ranking-only heading/filename form. Does not rewrite stored filenames. */
export function normalizeKnowledgeHeading(value: string): string {
  return String(value || "")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/\s*\(\s*\d+\s*\)\s*/g, " ")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function compactNormalizedHeading(value: string): string {
  return normalizeKnowledgeHeading(value).replace(/\s+/g, "");
}

function headingSearchNeedles(query: string): string[] {
  const normalized = normalizeKnowledgeHeading(query);
  const compact = compactNormalizedHeading(query);
  const underscored = normalized.replace(/\s+/g, "_");
  const hyphenated = normalized.replace(/\s+/g, "-");
  return [...new Set([normalized, compact, underscored, hyphenated].filter((item) => item.length >= 4))];
}

function isYearToken(token: string): boolean {
  return /^\d{4}$/.test(token);
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
  if (isCalendarYearToken(token)) return "medium";
  if (isDocumentIdentifierToken(token) || /\d{5,}/.test(token)) return "high";
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
  for (const token of normalizeKnowledgeHeading(original).split(/\s+/)) consider(token);
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
  const highNonYear = highValueTokens.filter((token) => !isYearToken(token));
  const mediumTokens = tokens.filter((row) => row.cls === "medium").map((row) => row.token);
  const firstStageTokens = highNonYear.length
    ? highNonYear
    : mediumTokens.length
      ? mediumTokens
      : highValueTokens.length
        ? highValueTokens
        : tokens.filter((row) => row.cls !== "low").map((row) => row.token);
  const broadTokens = highNonYear.length
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

function wordPresent(text: string, needle: string): boolean {
  if (!needle) return false;
  if (/^\d{4,}$/.test(needle) || (/[a-z]/.test(needle) && /\d/.test(needle))) {
    return text.includes(needle) || compactAlnum(text).includes(compactAlnum(needle));
  }
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}([^a-z0-9]|$)`, "i").test(text);
}

export function tokenPresent(haystack: string, token: string): boolean {
  const needle = sanitizeLikeNeedle(token);
  if (!needle) return false;
  const text = haystack.toLowerCase();
  if (wordPresent(text, needle)) return true;
  return expandLexicalVariants(needle).some((variant) => variant !== needle && wordPresent(text, variant));
}

function knowledgePhraseNeedles(classified: ClassifiedKnowledgeQuery): string[] {
  const words = normalizeKnowledgeHeading(classified.normalized)
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !KNOWLEDGE_SEARCH_STOPWORDS.has(word) && !GENERIC_BUSINESS_TOKENS.has(word));
  const phrases: string[] = [];
  for (let index = 0; index < words.length - 1; index += 1) {
    addUnique(phrases, `${words[index]} ${words[index + 1]}`);
    addUnique(phrases, `${words[index]}-${words[index + 1]}`);
    addUnique(phrases, `${words[index]}_${words[index + 1]}`);
  }
  return phrases;
}

function headingTokenOverlap(heading: string, classified: ClassifiedKnowledgeQuery): number {
  const normalizedHeading = normalizeKnowledgeHeading(heading);
  const distinctive = classified.tokens.filter((row) => row.cls !== "low");
  return distinctive.filter((row) => tokenPresent(normalizedHeading, row.token)).length;
}

function scoreKnowledgeCandidate(row: KnowledgeCandidateRow, classified: ClassifiedKnowledgeQuery): number {
  const filename = (row.filename ?? "").toLowerCase();
  const title = (row.title ?? "").toLowerCase();
  const heading = `${title} ${filename}`.trim();
  const stem = filenameStem(filename);
  const titleStem = filenameStem(title);
  const compactHeading = compactAlnum(`${title} ${filename}`);
  const normalizedHeading = normalizeKnowledgeHeading(heading);
  const text = (row.text ?? "").toLowerCase();
  const meta = `${row.external_id ?? ""} ${row.metadata_json ?? ""}`.toLowerCase();
  const query = classified.normalized;
  const queryStem = filenameStem(query);
  const normalizedQuery = normalizeKnowledgeHeading(query);
  let score = 0;

  const normHeading = normalizeKnowledgeHeading(`${title} ${filename}`);
  const normQuery = normalizeKnowledgeHeading(classified.original);
  const compactNormHeading = compactNormalizedHeading(`${title} ${filename}`);
  const compactNormQuery = compactNormalizedHeading(classified.original);
  if (query && (filename === query || title === query || stem === queryStem || titleStem === queryStem)) score += 240;
  if (normQuery.length >= 6 && (normHeading === normQuery || normHeading.includes(normQuery))) score += 180;
  if (compactNormQuery.length >= 8 && compactNormHeading.includes(compactNormQuery)) score += 160;
  if (normalizedQuery.length >= 4 && (normalizedHeading === normalizedQuery || compactHeading === compactAlnum(normalizedQuery))) {
    score += 220;
  }
  if (query.length >= 4 && (filename.includes(query) || title.includes(query) || stem.includes(queryStem))) score += 140;
  if (normalizedQuery.length >= 4 && normalizedHeading.includes(normalizedQuery)) score += 130;
  if (classified.compact.length >= 6 && compactHeading.includes(classified.compact)) score += 120;
  for (const token of normQuery.split(/\s+/)) {
    if (token.length >= 3 && tokenPresent(normHeading, token)) {
      score += token.length >= 8 || isYearToken(token) ? 36 : 20;
    }
  }
  const overlap = headingTokenOverlap(heading, classified);
  if (overlap >= 2) score += 90;
  else if (overlap === 1) score += 25;

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
  if (hitMatchesKnowledgeConceptFamily({ title: row.title, filename: row.filename, text: row.text }, classified.original)) {
    score += 80;
  }
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
  const normHeading = normalizeKnowledgeHeading(heading);
  const normQueryTokens = normalizeKnowledgeHeading(query)
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !KNOWLEDGE_SEARCH_STOPWORDS.has(token));
  const normalizedOverlap = normQueryTokens.filter((token) => tokenPresent(normHeading, token));
  if (normalizedOverlap.length >= 2) return true;
  const compactNormQuery = compactNormalizedHeading(query);
  if (compactNormQuery.length >= 8 && compactNormalizedHeading(heading).includes(compactNormQuery)) return true;
  const headingDistinct = classified.tokens.filter((token) => token.cls !== "low" && tokenPresent(heading, token.token));
  if (headingDistinct.length >= 2) return true;
  if (headingTokenOverlap(heading, classified) >= 2) return true;
  if (hitMatchesKnowledgeConceptFamily(hit, query)) return true;
  const family = detectKnowledgeConceptFamily(query);
  if (classified.highValueTokens.length) {
    const identifiers = classified.highValueTokens.filter((token) => isDocumentIdentifierToken(token));
    const yearTokens = classified.highValueTokens.filter((token) => isYearToken(token));
    const titleHigh = classified.highValueTokens.filter((token) => !/\d/.test(token));
    if (identifiers.length) {
      return identifiers.some((token) => tokenPresent(haystack, token));
    }
    if (titleHigh.length && yearTokens.length) {
      return (
        titleHigh.some((token) => tokenPresent(heading, token) || tokenPresent(normHeading, token) || tokenPresent(haystack, token)) &&
        yearTokens.some((token) => tokenPresent(haystack, token) || tokenPresent(normHeading, token))
      );
    }
    if (family) {
      const headingHit = classified.highValueTokens.some((token) => tokenPresent(heading, token));
      if (headingHit) return true;
      return (
        looksLikePolicyOrProcedureHeading(heading) &&
        classified.highValueTokens.some((token) => tokenPresent(haystack, token))
      );
    }
    return classified.highValueTokens.some((token) => tokenPresent(haystack, token));
  }
  const medium = classified.tokens.filter((token) => token.cls === "medium");
  const distinctiveMedium = medium.filter((token) => !PROCEDURE_ASK_WORDS.has(token.token));
  if (family?.id === "process_procedure") {
    if (distinctiveMedium.some((token) => tokenPresent(heading, token.token))) return true;
    return medium.filter((token) => tokenPresent(heading, token.token)).length >= 2;
  }
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
  if (score >= 100) return true;
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
    .replace(/\s*\(\s*\d+\s*\)\s*/g, " ")
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

function likeNeedles(values: string[], max = 10): string[] {
  return [...new Set(values.map(sanitizeLikeNeedle).filter((value) => value.length >= 3))].slice(0, max);
}

async function fetchKnowledgeHeadingPool(
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
  )`;
  const sql = `SELECT d.id AS document_id, d.filename, d.title, d.stored_url, d.external_id, d.metadata_json,
            COALESCE(NULLIF(d.extracted_text, ''), c.text, '') AS text, COALESCE(c.chunk_index, 0) AS chunk_index
     FROM company_knowledge_documents d
     LEFT JOIN company_knowledge_chunks c ON c.document_id = d.id AND c.chunk_index = 0
     WHERE d.company_id = ?
       AND (${terms.map(() => fieldClause).join(" OR ")})
     LIMIT ?`;
  const binds: Array<string | number> = [companyId];
  for (const term of terms) {
    const like = `%${term}%`;
    binds.push(like, like);
  }
  binds.push(limit);
  const rows = await env.DB.prepare(sql).bind(...binds).all<KnowledgeCandidateRow>();
  return rows.results ?? [];
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

  const family = detectKnowledgeConceptFamily(input.query);
  const poolHigh = classified.highValueTokens.filter((token) => !isYearToken(token));
  const phraseNeedles = knowledgePhraseNeedles(classified);
  const lexicalNeedles = likeNeedles(
    [
      ...classified.tokens.filter((row) => row.cls !== "low").map((row) => row.token),
      ...classified.tokens.flatMap((row) => expandLexicalVariants(row.token).filter((item) => item.length >= 5)),
    ],
    10,
  );
  const exactNeedles = likeNeedles(
    [
      ...headingSearchNeedles(classified.original),
      classified.normalized,
      filenameStem(classified.normalized),
      normalizeKnowledgeHeading(classified.normalized),
      classified.compact,
      compactNormalizedHeading(classified.original),
      ...classified.references,
      ...(poolHigh.length ? poolHigh : classified.highValueTokens),
      ...phraseNeedles,
    ],
    10,
  );
  const distinctiveNeedles = likeNeedles(
    [...classified.firstStageTokens, ...lexicalNeedles],
    10,
  );
  const broadNeedles = likeNeedles([...classified.broadTokens, ...lexicalNeedles], 10);
  const headingNeedles = likeNeedles(
    [...exactNeedles, ...phraseNeedles, ...lexicalNeedles, ...classified.firstStageTokens],
    12,
  );

  const headingRows = await fetchKnowledgeHeadingPool(env, input.companyId, headingNeedles, 40);
  const exactRows = await fetchKnowledgeCandidatePool(env, input.companyId, exactNeedles, 40);
  const distinctiveRows = distinctiveNeedles.length
    ? await fetchKnowledgeCandidatePool(env, input.companyId, distinctiveNeedles, 40)
    : [];
  const broadRows = await fetchKnowledgeCandidatePool(env, input.companyId, broadNeedles, 80);
  const conceptRows = family
    ? await fetchKnowledgeHeadingPool(env, input.companyId, likeNeedles(family.documentNeedles, 8), 40)
    : [];
  const titleNeedles = likeNeedles([
    ...classified.firstStageTokens,
    ...normalizeKnowledgeHeading(classified.original)
      .split(/\s+/)
      .filter((token) => token.length >= 4 && !isYearToken(token)),
  ]);
  const titleRows = titleNeedles.length
    ? await fetchKnowledgeHeadingPool(env, input.companyId, titleNeedles, 40)
    : [];

  const merged = [...headingRows, ...exactRows, ...distinctiveRows, ...broadRows, ...conceptRows, ...titleRows];
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
