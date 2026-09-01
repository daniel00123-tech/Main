/**
 * Channel-independent document catalogue (metadata listing).
 * Newest / latest / uploaded / recently modified — not semantic search.
 */

import type { Env } from "../env";
import type { AdvertisedMcpTool } from "./mcp-knowledge-standard";
import {
  COMPANY_KNOWLEDGE_READ_TOOL,
  collectProviderHttpUrl,
  extractHitList,
  mapFetchArgumentsForCompanyMcp,
  toStandardFetchPayload,
  unwrapToolPayload,
} from "./mcp-knowledge-standard";
import { executeRegisteredMcpTool, listMcpEnvironments } from "./control-plane";
import { listMcpTools } from "./mcp-client";
import { resolveMcpFetcher } from "./mcp-client";
import { newId, nowIso } from "../db/mappers";
import { acquireMicrosoftAppToken } from "./microsoft-auth";
import { searchRecentDriveItems } from "./microsoft-graph";
import { formatCivilDate, londonCivilParts } from "./intelligence/periods";
import { elvexCan, isElvexCompany } from "@infra/shared";
import type { CompanyRole } from "@infra/shared";

export const LIST_DOCUMENTS_TOOL = "list_documents";
export const DOCUMENT_CATALOGUE_ACTION = "knowledge.catalogue";
export const DOCUMENT_CATALOGUE_PERMISSION_ACTION = "knowledge.read";

export const CATALOGUE_SOURCES = ["onedrive", "sharepoint", "drive", "email", "all"] as const;
export type CatalogueSource = (typeof CATALOGUE_SOURCES)[number];
export const CATALOGUE_SORTS = ["newest", "oldest", "recently_modified"] as const;
export type CatalogueSort = (typeof CATALOGUE_SORTS)[number];
export type CatalogueDateField = "modified_at" | "created_at";

export type CatalogueDocument = {
  id: string;
  title: string;
  source: string;
  createdAt: string | null;
  modifiedAt: string | null;
  fileType: string | null;
  url: string;
  description: string;
  descriptionSource: "indexed_content" | "filename_only" | "unavailable";
  sortTimestamp: string | null;
};

export type CatalogueQuery = {
  source: CatalogueSource;
  sort: CatalogueSort;
  dateField: CatalogueDateField;
  dateFieldReason: string;
  limit: number;
  fileType: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  titleContains: string | null;
  includeDescriptions: boolean;
};

export type CatalogueResult = {
  status: "ok" | "connected_empty" | "not_connected";
  code: string;
  source: CatalogueSource;
  connectedSources: string[];
  sort: CatalogueSort;
  dateField: CatalogueDateField;
  dateFieldReason: string;
  limit: number;
  count: number;
  documents: CatalogueDocument[];
  backend: string[];
  message: string;
};

const WRITE_LIKE = /send|write|delete|draft|manage|create|update|upload|index/i;
const LIST_TOOL =
  /^(list|recent|catalogue|catalog|browse)_.*(document|file|drive|onedrive|sharepoint|knowledge)|^(list|recent).*(documents?|files?|drive|onedrive|sharepoint)|list_elvex_.*(file|document|drive)|search_elvex_files|recent_.*(file|document)|list_company_knowledge|list_knowledge/i;

export const LIST_DOCUMENTS_DESCRIPTION =
  "List connected document metadata by recency (newest, latest, uploaded, recently modified). Use this for catalogue listing — not semantic search, not index counts, and not reading one open document. Returns real titles, timestamps, file types, and genuine provider URLs only. Never invent files. Read-only.";

export function documentCatalogueToolDefinition(): AdvertisedMcpTool {
  return {
    name: LIST_DOCUMENTS_TOOL,
    description: LIST_DOCUMENTS_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: [...CATALOGUE_SOURCES],
          description: "onedrive, sharepoint, drive (Google Drive), email (mailbox attachments), or all connected sources.",
        },
        sort: {
          type: "string",
          enum: [...CATALOGUE_SORTS],
          description:
            "newest = newly added/uploaded when the user said uploaded/added; recently_modified = last changed. Ambiguous latest → recently_modified.",
        },
        limit: { type: "number", minimum: 1, maximum: 100, default: 10 },
        file_type: { type: "string", description: "Optional extension or mime fragment, e.g. pdf or application/pdf." },
        date_from: { type: "string", description: "Inclusive lower bound YYYY-MM-DD (Europe/London)." },
        date_to: { type: "string", description: "Inclusive upper bound YYYY-MM-DD (Europe/London)." },
        include_descriptions: {
          type: "boolean",
          description: "If true, add a short description from indexed content when available. Never fabricate.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "List documents by metadata",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  };
}

export function isDocumentCatalogueTool(name: string): boolean {
  return name === LIST_DOCUMENTS_TOOL;
}

export function documentCatalogueToolsAllowed(scopes?: readonly string[]): boolean {
  if (!scopes) return true;
  if (scopes.includes("*")) return true;
  return scopes.some(
    (scope) =>
      scope === "knowledge.read" ||
      scope === "knowledge.search" ||
      scope === "knowledge.catalogue" ||
      scope.startsWith("knowledge."),
  );
}

export function withDocumentCatalogueTools<T extends { name: string; description: string; inputSchema: Record<string, unknown> }>(
  tools: T[],
  scopes?: readonly string[],
): Array<T | AdvertisedMcpTool> {
  if (!documentCatalogueToolsAllowed(scopes)) return tools;
  if (tools.some((tool) => tool.name === LIST_DOCUMENTS_TOOL)) return tools;
  const names = new Set(tools.map((tool) => tool.name));
  const hasKnowledge =
    names.has("search") ||
    names.has("fetch") ||
    names.has("search_company_knowledge") ||
    names.has("get_knowledge_document");
  if (!hasKnowledge) return tools;
  return [...tools, documentCatalogueToolDefinition()];
}

function asNonEmpty(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function clampLimit(value: unknown, fallback = 10): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(1, Math.floor(n)));
}

function parseSource(value: unknown): CatalogueSource {
  const raw = asNonEmpty(value).toLowerCase();
  if (raw === "onedrive" || raw === "one drive") return "onedrive";
  if (raw === "sharepoint") return "sharepoint";
  if (raw === "drive" || raw === "google_drive" || raw === "gdrive" || raw === "google drive") return "drive";
  if (raw === "email" || raw === "outlook" || raw === "mailbox") return "email";
  return "all";
}

function parseSort(value: unknown): CatalogueSort {
  const raw = asNonEmpty(value).toLowerCase();
  if (raw === "oldest") return "oldest";
  if (raw === "recently_modified" || raw === "modified" || raw === "changed") return "recently_modified";
  if (raw === "newest" || raw === "latest" || raw === "created" || raw === "uploaded") return "newest";
  return "recently_modified";
}

export function sanitizeCatalogueArguments(args: Record<string, unknown>): CatalogueQuery {
  const source = parseSource(args.source);
  const sort = parseSort(args.sort);
  const uploaded =
    sort === "newest" &&
    /\b(upload|added|created|new(ly)? added)\b/i.test(`${args.sort ?? ""} ${args.dateField ?? ""}`);
  const dateField: CatalogueDateField =
    asNonEmpty(args.dateField) === "created_at" || uploaded ? "created_at" : "modified_at";
  return {
    source,
    sort,
    dateField,
    dateFieldReason:
      dateField === "created_at"
        ? "Sorted by source created/uploaded time where available."
        : "Sorted by last modified time.",
    limit: clampLimit(args.limit ?? args.top, 10),
    fileType: asNonEmpty(args.file_type) || asNonEmpty(args.fileType) || null,
    dateFrom: asNonEmpty(args.date_from) || asNonEmpty(args.dateFrom) || null,
    dateTo: asNonEmpty(args.date_to) || asNonEmpty(args.dateTo) || null,
    titleContains: asNonEmpty(args.titleContains) || asNonEmpty(args.title_contains) || null,
    includeDescriptions: args.include_descriptions === false || args.includeDescriptions === false ? false : true,
  };
}

const RECENCY =
  /\b(newest|latest|most recent|recently (modified|changed|updated|added|uploaded)|newly (added|uploaded)|just (added|uploaded)|uploaded|added (today|yesterday|this week|since)|changed (today|yesterday|this week)|what (was|were) (uploaded|added|changed)|what changed|the latest( \d+| ten| few)?)\b/i;
const CATALOGUE_NOUN =
  /\b(documents?|files?|pdfs?|spreadsheets?|docx?|policies|policy|the latest( \d+| ten| few)?)\b/i;
const ABOUT_TOPIC = /\b(about|mention|contain|talk(?:s|ing)? about|cover(?:s|ing)?)\b/i;
const FIND = /\b((can you |could you |please )?(find|search|look(?:ing)? (for|up)|pull up)|have we got|where is)\b/i;

export function isCatalogueListingAsk(text: string): boolean {
  const trimmed = text.trim();
  if (!RECENCY.test(trimmed) && !/\b(uploaded|added since|changed this|changed today)\b/i.test(trimmed)) {
    return false;
  }
  if (FIND.test(trimmed) && ABOUT_TOPIC.test(trimmed)) return false;
  if (/\bhow many\b/i.test(trimmed) && !RECENCY.test(trimmed)) return false;
  return (
    CATALOGUE_NOUN.test(trimmed) ||
    /\b(onedrive|sharepoint|(google )?drive|uploaded|added|changed|what they('re| are) about)\b/i.test(trimmed)
  );
}

function addDays(year: number, month: number, day: number, delta: number): { year: number; month: number; day: number } {
  const utc = new Date(Date.UTC(year, month - 1, day + delta));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

function mondayOfWeek(parts: { year: number; month: number; day: number }): { year: number; month: number; day: number } {
  const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const mondayDelta = (utc.getUTCDay() + 6) % 7;
  return addDays(parts.year, parts.month, parts.day, -mondayDelta);
}

export function parseCatalogueIntent(text: string, now = new Date()): CatalogueQuery {
  const london = londonCivilParts(now);
  const today = formatCivilDate(london);
  let source: CatalogueSource = "all";
  if (/\bonedrive\b/i.test(text)) source = "onedrive";
  else if (/\bsharepoint\b/i.test(text)) source = "sharepoint";
  else if (/\b(google )?drive\b/i.test(text) && !/\bonedrive\b/i.test(text)) source = "drive";
  else if (/\b(email|outlook|mailbox|attachment)\b/i.test(text)) source = "email";

  const uploaded = /\b(upload|uploaded|added|newly added|created)\b/i.test(text);
  const oldest = /\boldest\b/i.test(text);
  const sort: CatalogueSort = oldest ? "oldest" : uploaded ? "newest" : "recently_modified";
  const dateField: CatalogueDateField = uploaded && !/\b(modified|changed|updated)\b/i.test(text) ? "created_at" : "modified_at";

  let dateFrom: string | null = null;
  let dateTo: string | null = today;
  if (/\btoday\b/i.test(text)) {
    dateFrom = today;
  } else if (/\byesterday\b/i.test(text) || /\bsince yesterday\b/i.test(text)) {
    const y = addDays(london.year, london.month, london.day, -1);
    dateFrom = formatCivilDate(y);
    if (/\bsince yesterday\b/i.test(text)) dateTo = today;
    else dateTo = formatCivilDate(y);
  } else if (/\bthis week\b/i.test(text)) {
    dateFrom = formatCivilDate(mondayOfWeek(london));
  } else if (/\blast week\b/i.test(text)) {
    const start = addDays(mondayOfWeek(london).year, mondayOfWeek(london).month, mondayOfWeek(london).day, -7);
    const end = addDays(start.year, start.month, start.day, 6);
    dateFrom = formatCivilDate(start);
    dateTo = formatCivilDate(end);
  } else {
    dateTo = null;
  }

  const limitMatch = text.match(/\b(latest|newest|last|top)\s+(\d{1,3})\b/i) ?? text.match(/\b(\d{1,3})\s+(files?|documents?|pdfs?)\b/i);
  const limit = clampLimit(limitMatch?.[2] ?? limitMatch?.[1] ?? (/newest document|most recently/i.test(text) ? 1 : 10));

  let fileType: string | null = null;
  if (/\bpdfs?\b/i.test(text)) fileType = "pdf";
  else if (/\bdocx?\b/i.test(text)) fileType = "docx";
  else if (/\bxlsx?\b/i.test(text)) fileType = "xlsx";

  const titleContains = /\bpolic(y|ies)\b/i.test(text) && !ABOUT_TOPIC.test(text) ? "policy" : null;

  return {
    source,
    sort,
    dateField,
    dateFieldReason:
      dateField === "created_at"
        ? "Sorted by source created/uploaded time where available; falls back to last modified when created time is not stored."
        : "Sorted by last modified time.",
    limit,
    fileType,
    dateFrom,
    dateTo,
    titleContains,
    includeDescriptions: /\b(about|descri|what (are|is) they)\b/i.test(text),
  };
}

function sourceMatches(requested: CatalogueSource, actual: string): boolean {
  const value = actual.toLowerCase();
  if (requested === "all") return value !== "outlook_shared" && value !== "email";
  if (requested === "onedrive") return value === "onedrive" || value.includes("onedrive");
  if (requested === "sharepoint") return value === "sharepoint" || value.includes("sharepoint");
  if (requested === "drive") return value === "google_drive" || value === "gdrive" || value === "drive";
  if (requested === "email") return value === "outlook_shared" || value === "email" || value.includes("outlook");
  return false;
}

function fileTypeMatches(fileType: string | null, mime: string | null, title: string): boolean {
  if (!fileType) return true;
  const needle = fileType.replace(/^\./, "").toLowerCase();
  const hay = `${mime ?? ""} ${title}`.toLowerCase();
  if (needle === "pdf") return hay.includes("pdf");
  if (needle === "docx" || needle === "doc") return hay.includes("word") || hay.includes(".doc");
  if (needle === "xlsx" || needle === "xls") return hay.includes("sheet") || hay.includes(".xls");
  return hay.includes(needle);
}

function isoDateOnly(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

function inDateRange(timestamp: string | null, from: string | null, to: string | null): boolean {
  const day = isoDateOnly(timestamp);
  if (!day) return !from && !to;
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

function fileTypeFrom(mime: string | null, title: string): string | null {
  const ext = title.match(/\.([a-z0-9]{2,5})$/i)?.[1];
  if (ext) return ext.toLowerCase();
  if (!mime) return null;
  if (mime.includes("pdf")) return "pdf";
  if (mime.includes("word")) return "docx";
  if (mime.includes("sheet")) return "xlsx";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("png")) return "png";
  return mime.split("/").pop() ?? mime;
}

function parseProvenance(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function sourceCreatedAt(provenance: Record<string, unknown>, fallback: string | null): string | null {
  const candidate =
    asNonEmpty(provenance.createdDateTime) ||
    asNonEmpty(provenance.created_at) ||
    asNonEmpty(provenance.itemCreatedAt) ||
    asNonEmpty(provenance.sourceCreatedAt) ||
    asNonEmpty(provenance.driveCreatedTime);
  return candidate || fallback;
}

function isRestrictedItem(provenance: Record<string, unknown>, visibility?: string | null): boolean {
  if (visibility && /restrict|hidden|tombstone/i.test(visibility)) return true;
  return provenance.restricted === true || provenance.visibility === "restricted";
}

function sortDocuments(items: CatalogueDocument[], query: CatalogueQuery): CatalogueDocument[] {
  const field = query.dateField;
  const dir = query.sort === "oldest" ? 1 : -1;
  return [...items].sort((a, b) => {
    const aVal = field === "created_at" ? a.createdAt || a.modifiedAt : a.modifiedAt || a.createdAt;
    const bVal = field === "created_at" ? b.createdAt || b.modifiedAt : b.modifiedAt || b.createdAt;
    if (!aVal && !bVal) return 0;
    if (!aVal) return 1;
    if (!bVal) return -1;
    const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
    return dir * cmp;
  });
}

function describeFromIndexedText(text: string, title: string): Pick<CatalogueDocument, "description" | "descriptionSource"> {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return {
      description: `Description unavailable — only the filename “${title}” is available.`,
      descriptionSource: "filename_only",
    };
  }
  const sentences = cleaned.split(/(?<=[.!?])\s+/).filter((part) => part.length > 20);
  const summary = (sentences.slice(0, 2).join(" ") || cleaned).slice(0, 320);
  return { description: summary, descriptionSource: "indexed_content" };
}

type ConnectedSource = { key: string; connected: boolean; definitionId: string };

async function loadConnectedSources(db: D1Database, companyId: string): Promise<ConnectedSource[]> {
  const rows = await db
    .prepare(
      `SELECT connector_definition_id, name, auth_status, status
       FROM connector_instances
       WHERE company_id = ?
         AND auth_status = 'connected'
         AND COALESCE(status, '') NOT IN ('disabled', 'draft', 'archived')`,
    )
    .bind(companyId)
    .all<{ connector_definition_id: string; name: string; auth_status: string; status: string }>();

  const keys = new Map<string, ConnectedSource>();
  for (const row of rows.results ?? []) {
    const def = String(row.connector_definition_id);
    const name = String(row.name ?? "").toLowerCase();
    const mark = (key: string) => keys.set(key, { key, connected: true, definitionId: def });
    if (def === "conn_onedrive" || name.includes("onedrive")) mark("onedrive");
    if (def === "conn_sharepoint" || name.includes("sharepoint")) mark("sharepoint");
    if (def === "conn_google_drive" || name.includes("google drive") || name.includes("gdrive")) mark("drive");
    if (def === "conn_outlook_shared" || name.includes("outlook")) mark("email");
    if (def === "conn_microsoft_365" || name.includes("microsoft")) {
      mark("onedrive");
      mark("sharepoint");
      mark("email");
    }
  }
  return [...keys.values()];
}

function requestedSourceConnected(requested: CatalogueSource, connected: ConnectedSource[]): boolean {
  if (requested === "all") return connected.some((item) => item.key !== "email");
  return connected.some((item) => item.key === requested);
}

type InfraRow = {
  id: string;
  title: string;
  source_type: string;
  mime_type: string | null;
  modified_at: string | null;
  created_at: string | null;
  web_url: string | null;
  knowledge_document_id: number | null;
  external_item_id: string | null;
  path: string | null;
  provenance_json: string | null;
  visibility_status: string | null;
  indexing_status: string | null;
};

async function queryInfraKnowledgeItems(
  db: D1Database,
  companyId: string,
  query: CatalogueQuery,
  allowRestricted: boolean,
): Promise<CatalogueDocument[]> {
  const rows = await db
    .prepare(
      `SELECT id, title, source_type, mime_type, modified_at, created_at, web_url,
              knowledge_document_id, external_item_id, path, provenance_json,
              visibility_status, indexing_status
       FROM microsoft_knowledge_items
       WHERE company_id = ?
         AND COALESCE(visibility_status, 'active') = 'active'`,
    )
    .bind(companyId)
    .all<InfraRow>();

  const documents: CatalogueDocument[] = [];
  for (const row of rows.results ?? []) {
    const provenance = parseProvenance(row.provenance_json);
    if (!allowRestricted && isRestrictedItem(provenance, row.visibility_status)) continue;
    if (!sourceMatches(query.source, row.source_type)) continue;
    if (!fileTypeMatches(query.fileType, row.mime_type, row.title)) continue;
    if (query.titleContains && !row.title.toLowerCase().includes(query.titleContains.toLowerCase())) continue;
    const createdAt = sourceCreatedAt(provenance, null);
    const modifiedAt = row.modified_at;
    const sortTs = query.dateField === "created_at" ? createdAt || modifiedAt : modifiedAt;
    if (!inDateRange(sortTs, query.dateFrom, query.dateTo)) continue;
    const url = collectProviderHttpUrl(row.web_url, provenance);
    documents.push({
      id: row.knowledge_document_id != null ? String(row.knowledge_document_id) : row.external_item_id || row.id,
      title: row.title,
      source: row.source_type,
      createdAt,
      modifiedAt,
      fileType: fileTypeFrom(row.mime_type, row.title),
      url,
      description: "",
      descriptionSource: "unavailable",
      sortTimestamp: sortTs,
    });
  }
  return documents;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function documentsFromMcpPayload(payload: unknown, query: CatalogueQuery, allowRestricted: boolean): CatalogueDocument[] {
  const hits = extractHitList(payload);
  const extra = isRecord(payload)
    ? ([] as unknown[])
        .concat(Array.isArray(payload.documents) ? payload.documents : [])
        .concat(Array.isArray(payload.items) ? payload.items : [])
        .concat(Array.isArray(payload.files) ? payload.files : [])
        .concat(Array.isArray(payload.value) ? payload.value : [])
    : [];
  const records = [...hits, ...extra.filter(isRecord)];
  const documents: CatalogueDocument[] = [];
  for (const hit of records) {
    const provenance = isRecord(hit.metadata) ? hit.metadata : isRecord(hit.provenance) ? hit.provenance : {};
    if (!allowRestricted && isRestrictedItem(provenance)) continue;
    const source =
      asNonEmpty(hit.source) ||
      asNonEmpty(hit.source_type) ||
      asNonEmpty(hit.category) ||
      asNonEmpty(provenance.source) ||
      (query.source !== "all" ? query.source : "onedrive");
    if (!sourceMatches(query.source, source) && query.source !== "all") continue;
    const title = asNonEmpty(hit.title) || asNonEmpty(hit.name) || asNonEmpty(hit.filename) || "Untitled document";
    const mime = asNonEmpty(hit.mimeType) || asNonEmpty(hit.mime_type) || null;
    if (!fileTypeMatches(query.fileType, mime, title)) continue;
    if (query.titleContains && !title.toLowerCase().includes(query.titleContains.toLowerCase())) continue;
    const createdAt =
      asNonEmpty(hit.createdAt) ||
      asNonEmpty(hit.created_at) ||
      asNonEmpty(hit.driveCreatedTime) ||
      sourceCreatedAt(provenance, null);
    const modifiedAt =
      asNonEmpty(hit.modifiedAt) ||
      asNonEmpty(hit.modified_at) ||
      asNonEmpty(hit.driveModifiedTime) ||
      asNonEmpty(hit.lastModifiedDateTime) ||
      null;
    const sortTs = query.dateField === "created_at" ? createdAt || modifiedAt : modifiedAt || createdAt;
    if (!inDateRange(sortTs, query.dateFrom, query.dateTo)) continue;
    const id =
      asNonEmpty(hit.id) ||
      asNonEmpty(hit.documentId) ||
      asNonEmpty(hit.document_id) ||
      asNonEmpty(hit.external_id) ||
      asNonEmpty(hit.externalId);
    if (!id) continue;
    const snippet = asNonEmpty(hit.snippet) || asNonEmpty(hit.excerpt) || asNonEmpty(hit.text) || asNonEmpty(hit.summary);
    const described = snippet
      ? describeFromIndexedText(snippet, title)
      : { description: "", descriptionSource: "unavailable" as const };
    documents.push({
      id,
      title,
      source,
      createdAt,
      modifiedAt,
      fileType: fileTypeFrom(mime, title),
      url: collectProviderHttpUrl(hit, provenance),
      description: described.description,
      descriptionSource: described.descriptionSource,
      sortTimestamp: sortTs,
    });
  }
  return documents;
}

function catalogueAuthCandidates(
  env: Env,
  mcp: { serviceBindingRef?: string | null; adminSecretRef?: string | null; authSecretRef?: string | null },
): string[] {
  const refs: string[] = [];
  if (mcp.adminSecretRef) refs.push(mcp.adminSecretRef);
  if (mcp.authSecretRef) refs.push(mcp.authSecretRef);
  if ((mcp.serviceBindingRef ?? "") === "CADDINGTON_MCP") refs.push("CADDINGTON_ADMIN_TOKEN");
  const headers: string[] = [];
  for (const ref of refs) {
    const secret = (env as Record<string, unknown>)[ref];
    if (typeof secret !== "string" || !secret.trim()) continue;
    const header = `Bearer ${secret.trim().replace(/^Bearer\s+/i, "")}`;
    if (!headers.includes(header)) headers.push(header);
  }
  return headers;
}

async function fetchMcpAdminJson(
  env: Env,
  mcp: { endpointUrl: string; serviceBindingRef?: string | null; adminSecretRef?: string | null; authSecretRef?: string | null },
  path: string,
): Promise<unknown | null> {
  const binding = resolveMcpFetcher(env, mcp.serviceBindingRef ?? null);
  const url = `https://company-mcp.internal${path}`;
  for (const authorization of catalogueAuthCandidates(env, mcp)) {
    try {
      const response = binding
        ? await binding.fetch(new Request(url, { headers: { Authorization: authorization } }))
        : await fetch(`${mcp.endpointUrl.replace(/\/mcp\/?$/, "")}${path}`, {
            headers: { Authorization: authorization },
          });
      if (!response.ok) continue;
      return await response.json();
    } catch {
      continue;
    }
  }
  return null;
}

async function queryCompanyMcpCatalogue(
  env: Env,
  companyId: string,
  query: CatalogueQuery,
  allowRestricted: boolean,
  actor: string,
  actorUserId?: string | null,
): Promise<{ documents: CatalogueDocument[]; backend: string[] }> {
  const mcp = (await listMcpEnvironments(env.DB, companyId)).find((item) => item.enabled);
  if (!mcp) return { documents: [], backend: [] };
  const backend: string[] = [];
  const documents: CatalogueDocument[] = [];

  const since = query.dateFrom ? `${query.dateFrom}T00:00:00.000Z` : "2015-01-01T00:00:00.000Z";
  const until = query.dateTo ? `${query.dateTo}T23:59:59.999Z` : new Date().toISOString();
  const activity = await fetchMcpAdminJson(
    env,
    mcp,
    `/admin/knowledge/activity?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`,
  );
  if (activity) {
    documents.push(...documentsFromMcpPayload(activity, query, allowRestricted));
    backend.push("mcp_admin_activity");
  }
  for (const path of [
    `/admin/knowledge/documents?limit=${query.limit * 4}&sort=${query.dateField}`,
    `/admin/knowledge?limit=${query.limit * 4}`,
    `/admin/knowledge/list?limit=${query.limit * 4}`,
  ]) {
    const listed = await fetchMcpAdminJson(env, mcp, path);
    if (listed) {
      documents.push(...documentsFromMcpPayload(listed, query, allowRestricted));
      backend.push(`mcp_admin:${path.split("?")[0]}`);
    }
  }

  let toolNames: string[] = [];
  try {
    const tools = await listMcpTools(env, mcp.endpointUrl, mcp.authSecretRef, mcp.serviceBindingRef);
    toolNames = tools.tools.map((tool) => tool.name);
  } catch {
    toolNames = [];
  }
  const catalogueTool =
    toolNames.find((name) => name === "search_elvex_files") ??
    toolNames.find((name) => LIST_TOOL.test(name) && !WRITE_LIKE.test(name));
  if (catalogueTool) {
    const now = nowIso();
    for (const name of [catalogueTool, "get_elvex_file"]) {
      if (WRITE_LIKE.test(name)) continue;
      await env.DB.prepare(
        `INSERT OR IGNORE INTO mcp_tool_allowlist
          (id, company_id, mcp_environment_id, tool_name, risk_class, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'low_risk', 1, ?, ?)`,
      )
        .bind(newId("allow"), companyId, mcp.id, name, now, now)
        .run();
    }
    const execution = await executeRegisteredMcpTool(env, {
      mcpId: mcp.id,
      toolName: catalogueTool,
      arguments: {
        source: query.source === "all" ? undefined : query.source,
        sort: query.sort,
        orderBy: query.dateField === "created_at" ? "createdDateTime" : "lastModifiedDateTime",
        limit: Math.min(query.limit * 2, 50),
        top: Math.min(query.limit * 2, 50),
        file_type: query.fileType,
        date_from: query.dateFrom,
        date_to: query.dateTo,
      },
      actorUserId: actorUserId ?? "system",
      actorEmail: actor,
      sourceClient: "infra-document-catalogue",
      skipUsageRecording: true,
    });
    if (execution.status === 200) {
      const payload = unwrapToolPayload("data" in execution ? execution.data?.result : execution);
      documents.push(...documentsFromMcpPayload(payload, query, allowRestricted));
      backend.push(`mcp_tool:${catalogueTool}`);
    }
  }

  return { documents: dedupeDocuments(documents), backend };
}

function dedupeDocuments(items: CatalogueDocument[]): CatalogueDocument[] {
  const seen = new Set<string>();
  const out: CatalogueDocument[] = [];
  for (const item of items) {
    const key = `${item.source}:${item.id}:${item.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function queryGraphCatalogue(
  env: Env,
  companyId: string,
  query: CatalogueQuery,
  actor: string,
): Promise<CatalogueDocument[]> {
  if (query.source === "email" || query.source === "drive") return [];
  const instance = await env.DB.prepare(
    `SELECT id FROM connector_instances
     WHERE company_id = ?
       AND auth_status = 'connected'
       AND (
         connector_definition_id IN ('conn_microsoft_365', 'conn_onedrive', 'conn_sharepoint')
         OR microsoft_tenant_id IS NOT NULL
       )
     LIMIT 1`,
  )
    .bind(companyId)
    .first<{ id: string }>();
  if (!instance?.id) return [];
  const token = await acquireMicrosoftAppToken(env, {
    companyId,
    connectorInstanceId: instance.id,
    actor,
  });
  if (!token.ok) return [];
  try {
    const items = await searchRecentDriveItems(
      { accessToken: token.accessToken, tenantId: token.tenantId },
      {
        top: Math.min(query.limit * 3, 50),
        source: query.source === "all" ? undefined : query.source,
      },
    );
    return items
      .filter((item) => !item.folder)
      .map((item) => ({
        id: item.id,
        title: item.name,
        source: /[-.]my\.sharepoint\.com/i.test(item.webUrl ?? "") ? "onedrive" : "sharepoint",
        createdAt: item.createdDateTime ?? null,
        modifiedAt: item.lastModifiedDateTime,
        fileType: fileTypeFrom(item.file?.mimeType ?? item.mimeType ?? null, item.name),
        url: item.webUrl && /^https?:\/\//i.test(item.webUrl) ? item.webUrl : "",
        description: "",
        descriptionSource: "unavailable" as const,
        sortTimestamp: query.dateField === "created_at" ? item.createdDateTime ?? item.lastModifiedDateTime : item.lastModifiedDateTime,
      }))
      .filter((item) => sourceMatches(query.source, item.source))
      .filter((item) => fileTypeMatches(query.fileType, item.fileType, item.title))
      .filter((item) => !query.titleContains || item.title.toLowerCase().includes(query.titleContains.toLowerCase()))
      .filter((item) => inDateRange(item.sortTimestamp, query.dateFrom, query.dateTo));
  } catch {
    return [];
  }
}

async function attachDescriptions(
  env: Env,
  companyId: string,
  documents: CatalogueDocument[],
  actor: string,
  actorUserId?: string | null,
): Promise<void> {
  const mcp = (await listMcpEnvironments(env.DB, companyId)).find((item) => item.enabled);
  if (!mcp) {
    for (const doc of documents) {
      if (!doc.description) {
        doc.description = `Description unavailable — only the filename “${doc.title}” is available.`;
        doc.descriptionSource = "filename_only";
      }
    }
    return;
  }
  for (const doc of documents) {
    if (doc.descriptionSource === "indexed_content" && doc.description) continue;
    const execution = await executeRegisteredMcpTool(env, {
      mcpId: mcp.id,
      toolName: COMPANY_KNOWLEDGE_READ_TOOL,
      arguments: mapFetchArgumentsForCompanyMcp(doc.id),
      actorUserId: actorUserId ?? "system",
      actorEmail: actor,
      sourceClient: "infra-document-catalogue",
      skipUsageRecording: true,
    });
    if (execution.status !== 200 || !("data" in execution)) {
      const fileGet = await executeRegisteredMcpTool(env, {
        mcpId: mcp.id,
        toolName: "get_elvex_file",
        arguments: { id: doc.id, fileId: doc.id, documentRef: doc.id },
        actorUserId: actorUserId ?? "system",
        actorEmail: actor,
        sourceClient: "infra-document-catalogue",
        skipUsageRecording: true,
      });
      if (fileGet.status === 200) {
        const payload = toStandardFetchPayload("data" in fileGet ? fileGet.data?.result : fileGet, doc.id);
        const text = payload.text || (payload.chunks ?? []).map((chunk) => chunk.text).join("\n");
        const described = describeFromIndexedText(text, payload.title || doc.title);
        doc.description = described.description;
        doc.descriptionSource = described.descriptionSource;
        if (payload.title && payload.title !== "Untitled document") doc.title = payload.title;
        if (payload.url) doc.url = payload.url;
        continue;
      }
      doc.description = `Description unavailable — only the filename “${doc.title}” is available.`;
      doc.descriptionSource = "filename_only";
      continue;
    }
    const payload = toStandardFetchPayload("data" in execution ? execution.data?.result : execution, doc.id);
    const text = payload.text || (payload.chunks ?? []).map((chunk) => chunk.text).join("\n");
    if (!text) {
      const fileGet = await executeRegisteredMcpTool(env, {
        mcpId: mcp.id,
        toolName: "get_elvex_file",
        arguments: { id: doc.id, fileId: doc.id, documentRef: doc.id },
        actorUserId: actorUserId ?? "system",
        actorEmail: actor,
        sourceClient: "infra-document-catalogue",
        skipUsageRecording: true,
      });
      if (fileGet.status === 200) {
        const filePayload = toStandardFetchPayload("data" in fileGet ? fileGet.data?.result : fileGet, doc.id);
        const fileText = filePayload.text || (filePayload.chunks ?? []).map((chunk) => chunk.text).join("\n");
        const described = describeFromIndexedText(fileText, filePayload.title || doc.title);
        doc.description = described.description;
        doc.descriptionSource = described.descriptionSource;
        if (filePayload.title && filePayload.title !== "Untitled document") doc.title = filePayload.title;
        if (filePayload.url) doc.url = filePayload.url;
        continue;
      }
    }
    const described = describeFromIndexedText(text, payload.title || doc.title);
    doc.description = described.description;
    doc.descriptionSource = described.descriptionSource;
    if (payload.title && payload.title !== "Untitled document") doc.title = payload.title;
    if (payload.url) doc.url = payload.url;
  }
}

function emptyResult(
  query: CatalogueQuery,
  connected: string[],
  code: string,
  message: string,
  backend: string[],
): CatalogueResult {
  return {
    status: code === "CONNECTOR_NOT_CONNECTED" ? "not_connected" : "connected_empty",
    code,
    source: query.source,
    connectedSources: connected,
    sort: query.sort,
    dateField: query.dateField,
    dateFieldReason: query.dateFieldReason,
    limit: query.limit,
    count: 0,
    documents: [],
    backend,
    message,
  };
}

export async function executeListDocuments(
  env: Env,
  input: {
    companyId: string;
    arguments: Record<string, unknown>;
    actor: string;
    actorUserId?: string | null;
    role?: CompanyRole | string | null;
  },
): Promise<{ ok: true; result: CatalogueResult } | { ok: false; status: number; code: string; message: string }> {
  const query =
    typeof input.arguments.query === "string" && !input.arguments.source && !input.arguments.sort
      ? parseCatalogueIntent(String(input.arguments.query))
      : sanitizeCatalogueArguments(input.arguments);
  if (typeof input.arguments.query === "string" && (input.arguments.source || input.arguments.sort || input.arguments.limit)) {
    const parsed = parseCatalogueIntent(String(input.arguments.query));
    if (!input.arguments.source) query.source = parsed.source;
    if (!input.arguments.sort) {
      query.sort = parsed.sort;
      query.dateField = parsed.dateField;
      query.dateFieldReason = parsed.dateFieldReason;
    }
    if (input.arguments.limit == null) query.limit = parsed.limit;
    if (!query.fileType) query.fileType = parsed.fileType;
    if (!query.dateFrom) query.dateFrom = parsed.dateFrom;
    if (!query.dateTo) query.dateTo = parsed.dateTo;
    if (!query.titleContains) query.titleContains = parsed.titleContains;
  }

  const connected = await loadConnectedSources(env.DB, input.companyId);
  const connectedKeys = connected.map((item) => item.key);
  if (!requestedSourceConnected(query.source, connected)) {
    const label = query.source === "all" ? "document storage" : query.source;
    return {
      ok: true,
      result: emptyResult(
        query,
        connectedKeys,
        "CONNECTOR_NOT_CONNECTED",
        `${label} is not connected for this company, so there is no document catalogue to list.`,
        [],
      ),
    };
  }

  const allowRestricted =
    !isElvexCompany({ id: input.companyId }) || elvexCan(input.role ?? null, "knowledge.restricted.read");

  const infraItems = await queryInfraKnowledgeItems(env.DB, input.companyId, query, allowRestricted);
  const mcp = await queryCompanyMcpCatalogue(env, input.companyId, query, allowRestricted, input.actor, input.actorUserId);
  let documents = dedupeDocuments([...infraItems, ...mcp.documents]);
  const backend = [
    ...(infraItems.length ? ["microsoft_knowledge_items"] : []),
    ...mcp.backend,
  ];

  if (documents.length === 0) {
    const graphItems = await queryGraphCatalogue(env, input.companyId, query, input.actor);
    documents = graphItems;
    if (graphItems.length) backend.push("microsoft_graph");
  }

  documents = sortDocuments(documents, query).slice(0, query.limit);
  if (query.includeDescriptions && documents.length) {
    await attachDescriptions(env, input.companyId, documents, input.actor, input.actorUserId);
  } else {
    for (const doc of documents) {
      if (!doc.description) {
        doc.description = `Description unavailable — only the filename “${doc.title}” is available.`;
        doc.descriptionSource = "filename_only";
      }
    }
  }

  if (documents.length === 0) {
    const label = query.source === "all" ? "connected storage" : query.source;
    return {
      ok: true,
      result: emptyResult(
        query,
        connectedKeys,
        "CATALOGUE_EMPTY",
        `${label} is connected, but no document catalogue rows are available to list. Semantic search cannot substitute for newest/latest listing.`,
        backend,
      ),
    };
  }

  return {
    ok: true,
    result: {
      status: "ok",
      code: "SUCCESS",
      source: query.source,
      connectedSources: connectedKeys,
      sort: query.sort,
      dateField: query.dateField,
      dateFieldReason: query.dateFieldReason,
      limit: query.limit,
      count: documents.length,
      documents,
      backend,
      message: `${documents.length} document${documents.length === 1 ? "" : "s"} from the connected catalogue. ${query.dateFieldReason}`,
    },
  };
}

export function verbaliseDocumentCatalogue(data: unknown, question: string): string {
  if (!isRecord(data)) return "I could not read the document catalogue just now.";
  if (data.status === "not_connected") return String(data.message ?? "That source is not connected.");
  if (data.status === "connected_empty") return String(data.message ?? "No catalogue rows are available.");
  const docs = Array.isArray(data.documents) ? data.documents.filter(isRecord) : [];
  if (!docs.length) return String(data.message ?? "No documents matched that catalogue query.");
  const reason = asNonEmpty(data.dateFieldReason);
  const lines = docs.map((doc, index) => {
    const title = asNonEmpty(doc.title) || "Untitled document";
    const when = asNonEmpty(doc.modifiedAt) || asNonEmpty(doc.createdAt) || "timestamp unavailable";
    const source = asNonEmpty(doc.source) || "unknown";
    const type = asNonEmpty(doc.fileType);
    const url = asNonEmpty(doc.url);
    const description = asNonEmpty(doc.description);
    return `${index + 1}. ${title} (${source}${type ? `, ${type}` : ""}, ${when})${url ? ` — ${url}` : ""}${description ? `\n   ${description}` : ""}`;
  });
  const header = /\bnewest document\b/i.test(question)
    ? `Newest ${asNonEmpty(data.source) && data.source !== "all" ? `${data.source} ` : ""}document:`
    : `Latest ${docs.length} document${docs.length === 1 ? "" : "s"}:`;
  return [header, ...lines, reason].filter(Boolean).join("\n");
}
