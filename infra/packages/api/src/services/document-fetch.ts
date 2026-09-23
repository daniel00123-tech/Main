/**
 * Shared selected-document fetch for ChatGPT, WhatsApp, and Portal Chat.
 *
 * Caddington: get_knowledge_document remains the owner of indexed chunks.
 * Elvex: company MCP get_knowledge_document is a not_configured stub.
 * Real Elvex files live in the Microsoft catalogue / Graph (item id + drive id).
 */

import { isElvexCompany } from "@infra/shared";
import type { Env } from "../env";
import { executeRegisteredMcpTool, listMcpEnvironments } from "./control-plane";
import { newId, nowIso } from "../db/mappers";
import {
  COMPANY_KNOWLEDGE_READ_TOOL,
  collectProviderHttpUrl,
  extractHitList,
  mapFetchArgumentsForCompanyMcp,
  toStandardFetchPayload,
  unwrapToolPayload,
  type StandardDocumentChunk,
  type StandardFetchPayload,
} from "./mcp-knowledge-standard";
import { chunkExtractedText, extractDocumentBytes } from "./document-text-extract";

export const DOCUMENT_FETCH_AMBIGUOUS = "DOCUMENT_AMBIGUOUS";
export const ELVEX_FILE_GET_TOOL = "get_elvex_file";
export const ELVEX_FILE_SEARCH_TOOL = "search_elvex_files";
export const ELVEX_QUERY_TOOL = "query_business_data";

export type DocumentFetchCandidate = {
  documentId: string;
  title: string;
  source: string;
  sourceUrl: string;
  providerId: string;
  driveId?: string;
};

export type DocumentFetchOk = {
  ok: true;
  payload: StandardFetchPayload;
  diagnostics: {
    backend: string;
    chunkCount: number;
    titleSource: string;
    providerId: string | null;
    driveId: string | null;
    extractionMethod: string | null;
  };
};

export type DocumentFetchErr = {
  ok: false;
  status: number;
  code: string;
  message: string;
  candidates?: DocumentFetchCandidate[];
};

const PLACEHOLDER_TITLES = new Set(["", "untitled document", "untitled", "document"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNonEmpty(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function isCompanyKnowledgeReadTool(name: string): boolean {
  return name === "get_knowledge_document" || name === "fetch";
}

export function usableDocumentTitle(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const title = asNonEmpty(candidate);
    if (title && !PLACEHOLDER_TITLES.has(title.toLowerCase())) return title;
  }
  return "";
}

export function isEmptyKnowledgeFetch(payload: StandardFetchPayload, raw?: unknown): boolean {
  if (looksLikeNotConfiguredKnowledge(raw)) return true;
  const text = (payload.text ?? "").trim();
  const chunks = payload.chunks?.length ?? 0;
  return chunks === 0 && text.length < 40;
}

export function looksLikeNotConfiguredKnowledge(raw: unknown): boolean {
  const unwrapped = unwrapToolPayload(raw);
  return isRecord(unwrapped) && asNonEmpty(unwrapped.status).toLowerCase() === "not_configured";
}

export function titlesAreNearExact(left: string, right: string): boolean {
  return normalizeTitleKey(left) === normalizeTitleKey(right);
}

export function normalizeTitleKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.(pdf|docx?|xlsx?|pptx?)$/i, "")
    .replace(/\s+/g, " ");
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function ensureElvexFetchTools(
  env: Env,
  companyId: string,
  mcpId: string,
): Promise<void> {
  const now = nowIso();
  for (const toolName of [ELVEX_FILE_GET_TOOL, ELVEX_FILE_SEARCH_TOOL, ELVEX_QUERY_TOOL]) {
    await env.DB.prepare(
      `UPDATE mcp_tool_allowlist
       SET enabled = 1, risk_class = 'low_risk', updated_at = ?
       WHERE mcp_environment_id = ? AND tool_name = ?`,
    )
      .bind(now, mcpId, toolName)
      .run();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO mcp_tool_allowlist
        (id, company_id, mcp_environment_id, tool_name, risk_class, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'low_risk', 1, ?, ?)`,
    )
      .bind(newId("allow"), companyId, mcpId, toolName, now, now)
      .run();
  }
}

async function callCompanyTool(
  env: Env,
  input: {
    mcpId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    actor: string;
    actorUserId?: string | null;
    sourceClient: string;
  },
) {
  return executeRegisteredMcpTool(env, {
    mcpId: input.mcpId,
    toolName: input.toolName,
    arguments: input.arguments,
    actorUserId: input.actorUserId ?? "system",
    actorEmail: input.actor,
    sourceClient: input.sourceClient,
    skipUsageRecording: true,
  });
}

function rowsFromQueryPayload(payload: unknown): Record<string, unknown>[] {
  const unwrapped = unwrapToolPayload(payload);
  if (!isRecord(unwrapped)) return [];
  if (Array.isArray(unwrapped.rows)) return unwrapped.rows.filter(isRecord);
  return extractHitList(unwrapped);
}

function candidateFromRow(row: Record<string, unknown>): DocumentFetchCandidate | null {
  const itemId = asNonEmpty(row.item_id) || asNonEmpty(row.id) || asNonEmpty(row.itemId);
  const driveId = asNonEmpty(row.drive_id) || asNonEmpty(row.driveId);
  const title = usableDocumentTitle(row.filename, row.name, row.title, itemId);
  if (!itemId) return null;
  return {
    documentId: itemId,
    title,
    source: asNonEmpty(row.source_type) || asNonEmpty(row.sourceType) || asNonEmpty(row.source) || "sharepoint",
    sourceUrl: collectProviderHttpUrl(row),
    providerId: itemId,
    driveId: driveId || undefined,
  };
}

function candidateFromSearchHit(hit: Record<string, unknown>): DocumentFetchCandidate | null {
  const itemId = asNonEmpty(hit.id) || asNonEmpty(hit.item_id) || asNonEmpty(hit.itemId);
  if (!itemId) return null;
  return {
    documentId: itemId,
    title: usableDocumentTitle(hit.name, hit.title, hit.filename, itemId),
    source: asNonEmpty(hit.sourceType) || asNonEmpty(hit.source_type) || "sharepoint",
    sourceUrl: collectProviderHttpUrl(hit),
    providerId: itemId,
    driveId: asNonEmpty(hit.driveId) || asNonEmpty(hit.drive_id) || undefined,
  };
}

async function lookupElvexCatalogue(
  env: Env,
  input: {
    mcpId: string;
    documentId: string;
    title: string | null;
    actor: string;
    actorUserId?: string | null;
    sourceClient: string;
  },
): Promise<{ matches: DocumentFetchCandidate[]; backend: string }> {
  const matches: DocumentFetchCandidate[] = [];
  const idSql = `SELECT item_id, drive_id, filename, web_url, source_type, path, mime_type, size, status
    FROM microsoft_index_items
    WHERE status = 'catalogue' AND item_id = ${sqlLiteral(input.documentId)}
    LIMIT 5`;
  const byId = await callCompanyTool(env, {
    mcpId: input.mcpId,
    toolName: ELVEX_QUERY_TOOL,
    arguments: { sql: idSql, limit: 5 },
    actor: input.actor,
    actorUserId: input.actorUserId,
    sourceClient: input.sourceClient,
  });
  if (byId.status === 200) {
    for (const row of rowsFromQueryPayload("data" in byId ? byId.data?.result : byId)) {
      const candidate = candidateFromRow(row);
      if (candidate) matches.push(candidate);
    }
    if (matches.length) return { matches, backend: "elvex_catalogue_id" };
  }

  if (input.title) {
    const titleSql = `SELECT item_id, drive_id, filename, web_url, source_type, path, mime_type, size, status
      FROM microsoft_index_items
      WHERE status = 'catalogue' AND (
        lower(ifnull(filename,'')) = lower(${sqlLiteral(input.title)})
        OR lower(replace(replace(replace(replace(ifnull(filename,''), '.pdf', ''), '.docx', ''), '.xlsx', ''), '.pptx', ''))
          = lower(${sqlLiteral(normalizeTitleKey(input.title))})
      )
      LIMIT 8`;
    const byTitle = await callCompanyTool(env, {
      mcpId: input.mcpId,
      toolName: ELVEX_QUERY_TOOL,
      arguments: { sql: titleSql, limit: 8 },
      actor: input.actor,
      actorUserId: input.actorUserId,
      sourceClient: input.sourceClient,
    });
    if (byTitle.status === 200) {
      for (const row of rowsFromQueryPayload("data" in byTitle ? byTitle.data?.result : byTitle)) {
        const candidate = candidateFromRow(row);
        if (candidate && titlesAreNearExact(candidate.title, input.title)) matches.push(candidate);
      }
      if (matches.length) return { matches, backend: "elvex_catalogue_title" };
    }
  }
  return { matches, backend: "elvex_catalogue_miss" };
}

async function lookupElvexSearch(
  env: Env,
  input: {
    mcpId: string;
    documentId: string;
    title: string | null;
    actor: string;
    actorUserId?: string | null;
    sourceClient: string;
  },
): Promise<DocumentFetchCandidate[]> {
  const queries = [input.documentId, input.title].filter((value): value is string => Boolean(value && value.trim()));
  const matches: DocumentFetchCandidate[] = [];
  const seen = new Set<string>();
  for (const query of queries) {
    const search = await callCompanyTool(env, {
      mcpId: input.mcpId,
      toolName: ELVEX_FILE_SEARCH_TOOL,
      arguments: { query, top: 12 },
      actor: input.actor,
      actorUserId: input.actorUserId,
      sourceClient: input.sourceClient,
    });
    if (search.status !== 200) continue;
    const hits = extractHitList("data" in search ? search.data?.result : search);
    for (const hit of hits) {
      const candidate = candidateFromSearchHit(hit);
      if (!candidate || seen.has(candidate.documentId)) continue;
      seen.add(candidate.documentId);
      matches.push(candidate);
    }
  }
  return matches;
}

function resolveUniqueCandidate(
  documentId: string,
  title: string | null,
  matches: DocumentFetchCandidate[],
): { candidate: DocumentFetchCandidate } | { ambiguous: DocumentFetchCandidate[] } | { none: true } {
  const byId = matches.filter((item) => item.documentId === documentId || item.providerId === documentId);
  if (byId.length === 1) return { candidate: byId[0]! };
  if (byId.length > 1) {
    const drives = new Set(byId.map((item) => item.driveId).filter(Boolean));
    if (drives.size === 1) return { candidate: byId[0]! };
    return { ambiguous: byId };
  }
  if (title) {
    const byTitle = matches.filter((item) => titlesAreNearExact(item.title, title));
    if (byTitle.length === 1) return { candidate: byTitle[0]! };
    if (byTitle.length > 1) return { ambiguous: byTitle };
  }
  return { none: true };
}

function decodeBase64Bytes(value: unknown): ArrayBuffer | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const binary = atob(value.trim());
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  } catch {
    return null;
  }
}

function payloadFromCandidate(
  documentId: string,
  candidate: DocumentFetchCandidate,
  text: string,
  chunks: StandardDocumentChunk[],
  extra?: Record<string, unknown>,
): StandardFetchPayload {
  const title = usableDocumentTitle(candidate.title, extra?.name, extra?.filename, documentId) || documentId;
  const url = collectProviderHttpUrl(candidate.sourceUrl, extra) || candidate.sourceUrl;
  return {
    id: documentId,
    title,
    text,
    url,
    metadata: {
      source: candidate.source,
      sourceType: candidate.source,
      providerId: candidate.providerId,
      driveId: candidate.driveId,
      drive_id: candidate.driveId,
      itemId: candidate.providerId,
      item_id: candidate.providerId,
      mimeType: extra?.mimeType ?? extra?.contentType,
      path: extra?.path,
      webUrl: url,
      web_url: url,
    },
    chunks: chunks.length ? chunks : undefined,
  };
}

async function fetchElvexFileContent(
  env: Env,
  input: {
    mcpId: string;
    candidate: DocumentFetchCandidate;
    documentId: string;
    actor: string;
    actorUserId?: string | null;
    sourceClient: string;
  },
): Promise<{ payload: StandardFetchPayload; extractionMethod: string | null }> {
  if (!input.candidate.driveId) {
    return {
      payload: payloadFromCandidate(input.documentId, input.candidate, "", []),
      extractionMethod: null,
    };
  }
  const fileGet = await callCompanyTool(env, {
    mcpId: input.mcpId,
    toolName: ELVEX_FILE_GET_TOOL,
    arguments: {
      drive_id: input.candidate.driveId,
      item_id: input.candidate.providerId,
      include_content: true,
    },
    actor: input.actor,
    actorUserId: input.actorUserId,
    sourceClient: input.sourceClient,
  });
  const raw = fileGet.status === 200 ? ("data" in fileGet ? fileGet.data?.result : fileGet) : null;
  const file = unwrapToolPayload(raw);
  const record = isRecord(file) ? file : {};
  const title = usableDocumentTitle(record.name, record.filename, record.title, input.candidate.title);
  const url = collectProviderHttpUrl(record, input.candidate.sourceUrl);
  const candidate = {
    ...input.candidate,
    title: title || input.candidate.title,
    sourceUrl: url || input.candidate.sourceUrl,
  };
  if (record.truncated === true && !record.contentBase64) {
    return {
      payload: payloadFromCandidate(input.documentId, candidate, "", [], record),
      extractionMethod: "truncated_no_bytes",
    };
  }
  const bytes = decodeBase64Bytes(record.contentBase64);
  if (!bytes) {
    return {
      payload: payloadFromCandidate(input.documentId, candidate, "", [], record),
      extractionMethod: null,
    };
  }
  const extracted = await extractDocumentBytes(env, {
    bytes,
    filename: candidate.title || input.documentId,
    mimeType: asNonEmpty(record.contentType) || asNonEmpty(record.mimeType),
  });
  const chunks = chunkExtractedText(input.documentId, extracted.text);
  return {
    payload: payloadFromCandidate(input.documentId, candidate, extracted.text, chunks, record),
    extractionMethod: extracted.method,
  };
}

function withRequestedId(payload: StandardFetchPayload, documentId: string, title?: string | null): StandardFetchPayload {
  return {
    ...payload,
    id: documentId,
    title: usableDocumentTitle(payload.title, title, documentId) || payload.title,
  };
}

export async function fetchCompanyKnowledgeDocument(
  env: Env,
  input: {
    companyId: string;
    documentId: string;
    title?: string | null;
    driveId?: string | null;
    actor: string;
    actorUserId?: string | null;
    sourceClient?: string;
  },
): Promise<DocumentFetchOk | DocumentFetchErr> {
  const documentId = input.documentId.trim();
  const title = input.title?.trim() || null;
  if (!documentId) {
    return { ok: false, status: 400, code: "DOCUMENT_ID_REQUIRED", message: "A document id is required." };
  }

  const mcp = (await listMcpEnvironments(env.DB, input.companyId)).find((item) => item.enabled);
  if (!mcp) {
    return { ok: false, status: 503, code: "KNOWLEDGE_MCP_UNAVAILABLE", message: "Business MCP unavailable" };
  }

  const sourceClient = input.sourceClient ?? "infra-document-fetch";
  const knowledge = await callCompanyTool(env, {
    mcpId: mcp.id,
    toolName: COMPANY_KNOWLEDGE_READ_TOOL,
    arguments: mapFetchArgumentsForCompanyMcp(documentId),
    actor: input.actor,
    actorUserId: input.actorUserId,
    sourceClient,
  });
  if (knowledge.status !== 200) {
    if (!isElvexCompany({ id: input.companyId })) {
      return {
        ok: false,
        status: knowledge.status >= 400 && knowledge.status < 600 ? knowledge.status : 502,
        code: "UPSTREAM_FAILURE",
        message: "I couldn’t reach that document just now.",
      };
    }
  } else {
    const raw = "data" in knowledge ? knowledge.data?.result : knowledge;
    const payload = withRequestedId(toStandardFetchPayload(raw, documentId), documentId, title);
    if (!isEmptyKnowledgeFetch(payload, raw)) {
      return {
        ok: true,
        payload,
        diagnostics: {
          backend: "company_knowledge",
          chunkCount: payload.chunks?.length ?? 0,
          titleSource: payload.title && payload.title !== "Untitled document" ? "knowledge" : "fallback",
          providerId: asNonEmpty(payload.metadata?.external_id) || documentId,
          driveId: asNonEmpty(payload.metadata?.driveId) || null,
          extractionMethod: null,
        },
      };
    }
    if (!isElvexCompany({ id: input.companyId })) {
      return {
        ok: true,
        payload,
        diagnostics: {
          backend: "company_knowledge_empty",
          chunkCount: 0,
          titleSource: usableDocumentTitle(payload.title, title) ? "search_title" : "placeholder",
          providerId: documentId,
          driveId: null,
          extractionMethod: null,
        },
      };
    }
  }

  await ensureElvexFetchTools(env, input.companyId, mcp.id);

  const seeded: DocumentFetchCandidate[] = [];
  if (input.driveId) {
    seeded.push({
      documentId,
      title: title || documentId,
      source: "sharepoint",
      sourceUrl: "",
      providerId: documentId,
      driveId: input.driveId,
    });
  }
  const catalogue = await lookupElvexCatalogue(env, {
    mcpId: mcp.id,
    documentId,
    title,
    actor: input.actor,
    actorUserId: input.actorUserId,
    sourceClient,
  });
  const searched = catalogue.matches.length
    ? []
    : await lookupElvexSearch(env, {
        mcpId: mcp.id,
        documentId,
        title,
        actor: input.actor,
        actorUserId: input.actorUserId,
        sourceClient,
      });
  const resolved = resolveUniqueCandidate(documentId, title, [...seeded, ...catalogue.matches, ...searched]);
  if ("ambiguous" in resolved) {
    return {
      ok: false,
      status: 409,
      code: DOCUMENT_FETCH_AMBIGUOUS,
      message: "Several documents share that title. Choose one by id.",
      candidates: resolved.ambiguous,
    };
  }
  if ("none" in resolved) {
    return {
      ok: true,
      payload: {
        id: documentId,
        title: title || "Untitled document",
        text: "",
        url: "",
        metadata: { source: "sharepoint", providerId: documentId },
      },
      diagnostics: {
        backend: "elvex_identity_miss",
        chunkCount: 0,
        titleSource: title ? "search_title" : "placeholder",
        providerId: documentId,
        driveId: null,
        extractionMethod: null,
      },
    };
  }

  const fetched = await fetchElvexFileContent(env, {
    mcpId: mcp.id,
    candidate: resolved.candidate,
    documentId,
    actor: input.actor,
    actorUserId: input.actorUserId,
    sourceClient,
  });
  const payload = withRequestedId(fetched.payload, documentId, title);
  return {
    ok: true,
    payload,
    diagnostics: {
      backend: catalogue.matches.length ? "elvex_file_catalogue" : "elvex_file_search",
      chunkCount: payload.chunks?.length ?? 0,
      titleSource: usableDocumentTitle(payload.title) ? "provider" : "search_title",
      providerId: resolved.candidate.providerId,
      driveId: resolved.candidate.driveId ?? null,
      extractionMethod: fetched.extractionMethod,
    },
  };
}
