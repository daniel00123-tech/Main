/**
 * Generic READ-ONLY document catalogue.
 * Metadata listing only — not a semantic search substitute, no extra LLM.
 */

import { isElvexCompany } from "@infra/shared";
import type { Env } from "../env";
import { getCompanyById, listMcpEnvironments } from "./control-plane";
import {
  catalogueFilesFromSearchPayload,
  executeElvexKnowledgeViaElFiles,
} from "./elvex-files-el-mcp";
import { resolveMcpAdminAuthHeader } from "./mcp-admin-bridge";
import { resolveMcpFetcher } from "./mcp-client";
const SOURCE_LABELS: Record<string, string> = {
  sharepoint: "SharePoint",
  onedrive: "OneDrive",
  google_drive: "Google Drive",
  gdrive: "Google Drive",
  drive: "Google Drive",
};

function userFacingSourceLabel(raw: string): string {
  const key = raw.trim().toLowerCase().replace(/\s+/g, "_");
  return SOURCE_LABELS[key] ?? raw.replace(/[_-]+/g, " ");
}

export const LIST_COMPANY_DOCUMENTS_TOOL = "list_company_documents";
export const DESCRIPTION_UNAVAILABLE = "Description unavailable from indexed content";

export type CatalogueSort = "newest" | "latest" | "indexed";
export type CatalogueSourceFilter = "onedrive" | "sharepoint" | "drive" | "all";

export type CatalogueDocument = {
  id: string;
  title: string;
  source: string;
  url: string | null;
  created_at: string | null;
  modified_at: string | null;
  indexed_at: string | null;
  description: string;
  descriptionSource: "summary" | "chunks" | "unavailable";
};

export type CatalogueResult = {
  sort: CatalogueSort;
  sortField: "created_at" | "modified_at" | "indexed_at";
  limit: number;
  documents: CatalogueDocument[];
  note: string;
};

type MicrosoftRow = {
  id: string;
  knowledge_document_id: number | null;
  title: string;
  source_type: string;
  web_url: string | null;
  path: string | null;
  created_at: string | null;
  modified_at: string | null;
  indexed_at: string | null;
  provenance_json: string | null;
};

type McpActivityDocument = {
  id?: string | number | null;
  title?: string;
  source?: string | null;
  category?: string | null;
  url?: string | null;
  webUrl?: string | null;
  createdAt?: string | null;
  driveModifiedTime?: string | null;
  modifiedAt?: string | null;
  indexedAt?: string | null;
  summary?: string | null;
  snippet?: string | null;
};

const FILE_SOURCES = new Set(["onedrive", "sharepoint", "google_drive", "gdrive", "drive"]);

export function resolveCatalogueSort(text: string): CatalogueSort {
  const hay = String(text ?? "").toLowerCase();
  if (/\b(what (did|has) infra index|what infra indexed|recently indexed|just indexed|last indexed)\b/.test(hay)) {
    return "indexed";
  }
  if (/\b(latest|most recently (changed|modified|updated)|recently (changed|modified|updated)|last changed|last modified)\b/.test(hay)) {
    return "latest";
  }
  return "newest";
}

export function resolveCatalogueSourceFilter(text: string): CatalogueSourceFilter {
  const hay = String(text ?? "").toLowerCase();
  if (/\bonedrive\b/.test(hay)) return "onedrive";
  if (/\bsharepoint\b/.test(hay)) return "sharepoint";
  if (/\b(google )?drive\b/.test(hay)) return "drive";
  return "all";
}

export function resolveCatalogueLimit(text: string, fallback = 10): number {
  const match = String(text ?? "").match(/\b(\d{1,2})\b/);
  if (!match) return fallback;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(20, n);
}

export function isDocumentCatalogueAsk(text: string): boolean {
  const hay = String(text ?? "").toLowerCase();
  if (/\b(xero|invoice|sales|revenue|outlook|mailbox|inbox)\b/.test(hay)) return false;
  const listing =
    /\b(newest|latest|most recent|recently (uploaded|added|changed|modified|updated)|last (10|ten|\d+) (files?|documents?|docs?)|what (files?|documents?) (were )?(uploaded|added|changed|modified)|show (me )?(the )?(newest|latest|recent))\b/.test(
      hay,
    );
  const corpus = /\b(files?|documents?|docs?|onedrive|sharepoint|drive)\b/.test(hay);
  return listing && corpus;
}

function parseProvenance(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function groundedDescription(input: {
  summary?: string | null;
  chunkText?: string | null;
  snippet?: string | null;
}): { description: string; descriptionSource: CatalogueDocument["descriptionSource"] } {
  const summary = firstString(input.summary);
  if (summary) return { description: clip(summary, 240), descriptionSource: "summary" };
  const chunk = firstString(input.chunkText, input.snippet);
  if (chunk) return { description: clip(chunk, 240), descriptionSource: "chunks" };
  return { description: DESCRIPTION_UNAVAILABLE, descriptionSource: "unavailable" };
}

function clip(value: string, max: number): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function matchesSourceFilter(sourceType: string, filter: CatalogueSourceFilter): boolean {
  const key = sourceType.toLowerCase().replace(/\s+/g, "_");
  if (filter === "all") {
    return FILE_SOURCES.has(key) || /onedrive|sharepoint|drive/.test(key);
  }
  if (filter === "onedrive") return /onedrive/.test(key);
  if (filter === "sharepoint") return /sharepoint/.test(key);
  return /google_drive|gdrive|^drive$/.test(key);
}

function sortFieldFor(sort: CatalogueSort): "created_at" | "modified_at" | "indexed_at" {
  if (sort === "latest") return "modified_at";
  if (sort === "indexed") return "indexed_at";
  return "created_at";
}

function timestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function fromMicrosoftRow(row: MicrosoftRow): CatalogueDocument {
  const provenance = parseProvenance(row.provenance_json);
  const grounded = groundedDescription({
    summary: firstString(provenance.summary, provenance.description),
    chunkText: firstString(provenance.excerpt, provenance.chunk, provenance.firstChunk),
    snippet: firstString(provenance.snippet),
  });
  return {
    id: row.knowledge_document_id ? String(row.knowledge_document_id) : row.id,
    title: row.title,
    source: userFacingSourceLabel(row.source_type),
    url: firstString(row.web_url, provenance.webUrl, provenance.web_url, provenance.url),
    created_at: row.created_at,
    modified_at: row.modified_at,
    indexed_at: row.indexed_at,
    ...grounded,
  };
}

async function loadMicrosoftDocuments(
  env: Pick<Env, "DB">,
  companyId: string,
  filter: CatalogueSourceFilter,
): Promise<CatalogueDocument[]> {
  try {
    const rows = await env.DB.prepare(
      `SELECT id, knowledge_document_id, title, source_type, web_url, path,
              created_at, modified_at, indexed_at, provenance_json
       FROM microsoft_knowledge_items
       WHERE company_id = ?
         AND COALESCE(visibility_status, 'active') = 'active'`,
    )
      .bind(companyId)
      .all<MicrosoftRow>();
    return (rows.results ?? [])
      .filter((row) => matchesSourceFilter(row.source_type, filter))
      .map(fromMicrosoftRow);
  } catch {
    return [];
  }
}

async function loadMcpDocuments(
  env: Env,
  companyId: string,
  filter: CatalogueSourceFilter,
): Promise<CatalogueDocument[]> {
  const company = await getCompanyById(env.DB, companyId).catch(() => null);
  if (!company) return [];
  const environments = await listMcpEnvironments(env.DB, companyId).catch(() => []);
  const mcp = environments[0];
  if (!mcp) return [];
  const auth = resolveMcpAdminAuthHeader(env, mcp);
  if (!auth.authorizationHeader) return [];
  const binding = resolveMcpFetcher(env, mcp.serviceBindingRef ?? "CADDINGTON_MCP");
  const since = new Date(Date.now() - 1000 * 60 * 60 * 24 * 365 * 5).toISOString();
  const until = new Date().toISOString();
  const paths = [
    `/admin/knowledge/activity?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`,
    `/admin/knowledge/documents`,
  ];
  try {
    for (const path of paths) {
      const response = binding
        ? await binding.fetch(
            new Request(`https://company-mcp.internal${path}`, {
              headers: { Authorization: auth.authorizationHeader },
            }),
          )
        : await fetch(`${mcp.endpointUrl.replace(/\/mcp\/?$/, "")}${path}`, {
            headers: { Authorization: auth.authorizationHeader },
          });
      if (!response.ok) continue;
      const body = (await response.json()) as {
        documents?: McpActivityDocument[];
        items?: McpActivityDocument[];
      };
      const rows = body.documents ?? body.items ?? [];
      if (!rows.length) continue;
      return rows
        .filter(
          (doc) =>
            matchesSourceFilter(String(doc.source ?? doc.category ?? "drive"), filter === "all" ? "drive" : filter) ||
            filter === "all",
        )
        .map((doc) => {
          const grounded = groundedDescription({
            summary: doc.summary,
            snippet: doc.snippet,
          });
          return {
            id: String(doc.id ?? doc.title ?? "mcp"),
            title: String(doc.title ?? "Untitled"),
            source: userFacingSourceLabel(String(doc.source ?? doc.category ?? "drive")),
            url: firstString(doc.url, doc.webUrl),
            created_at: doc.createdAt ?? null,
            modified_at: doc.driveModifiedTime ?? doc.modifiedAt ?? null,
            indexed_at: doc.indexedAt ?? null,
            ...grounded,
          };
        });
    }
    return [];
  } catch {
    return [];
  }
}

async function loadElvexFileDocuments(
  env: Env,
  companyId: string,
  filter: CatalogueSourceFilter,
  text: string,
): Promise<CatalogueDocument[]> {
  if (!isElvexCompany({ id: companyId })) return [];
  const environments = await listMcpEnvironments(env.DB, companyId).catch(() => []);
  const mcp = environments.find((item) => item.enabled) ?? environments[0];
  if (!mcp) return [];
  const query = text.replace(/\b(newest|latest|recent|files?|documents?|docs?|list|show|uploaded|changed|modified)\b/gi, " ").trim() || "file";
  const listed = await executeElvexKnowledgeViaElFiles(env, {
    companyId,
    mcp,
    toolName: "search_elvex_files",
    arguments: { query, limit: 20 },
  });
  if (!listed.ok || !("results" in listed.result)) return [];
  return catalogueFilesFromSearchPayload(listed.result)
    .filter((doc) => matchesSourceFilter(doc.source, filter === "all" ? "drive" : filter) || filter === "all")
    .map((doc) => {
      const grounded = groundedDescription({ snippet: doc.description });
      return {
        id: doc.id,
        title: doc.title,
        source: userFacingSourceLabel(doc.source),
        url: doc.url,
        created_at: doc.created_at,
        modified_at: doc.modified_at,
        indexed_at: null,
        ...grounded,
      };
    });
}

export async function listCompanyDocuments(
  env: Env,
  input: {
    companyId: string;
    text?: string;
    sort?: CatalogueSort;
    source?: CatalogueSourceFilter;
    limit?: number;
  },
): Promise<CatalogueResult> {
  const text = input.text ?? "";
  const sort = input.sort ?? resolveCatalogueSort(text);
  const source = input.source ?? resolveCatalogueSourceFilter(text);
  const limit = Math.min(20, Math.max(1, input.limit ?? resolveCatalogueLimit(text)));
  const field = sortFieldFor(sort);

  const [microsoft, mcp, elvexFiles] = await Promise.all([
    loadMicrosoftDocuments(env, input.companyId, source),
    loadMcpDocuments(env, input.companyId, source),
    loadElvexFileDocuments(env, input.companyId, source, text),
  ]);

  const seen = new Set<string>();
  const merged: CatalogueDocument[] = [];
  for (const doc of [...microsoft, ...mcp, ...elvexFiles]) {
    const key = `${doc.title}::${doc.url ?? doc.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(doc);
  }

  merged.sort((left, right) => {
    const a = timestamp(left[field] ?? left.modified_at ?? left.created_at);
    const b = timestamp(right[field] ?? right.modified_at ?? right.created_at);
    return b - a;
  });

  return {
    sort,
    sortField: field,
    limit,
    documents: merged.slice(0, limit),
    note:
      sort === "indexed"
        ? "Sorted by INFRA index time because you asked what INFRA indexed."
        : sort === "latest"
          ? "Sorted by provider modified_at (latest changed)."
          : "Sorted by provider created_at (newest uploaded).",
  };
}

export function listCompanyDocumentsToolDefinition() {
  return {
    name: LIST_COMPANY_DOCUMENTS_TOOL,
    description:
      "List the newest or latest company files from OneDrive, SharePoint, or Drive using real file metadata. Not a semantic search. Use created_at for newest/uploaded and modified_at for latest/changed. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        sort: {
          type: "string",
          enum: ["newest", "latest", "indexed"],
          description: "newest=created_at, latest=modified_at, indexed=INFRA index time only when asked",
        },
        source: {
          type: "string",
          enum: ["all", "onedrive", "sharepoint", "drive"],
        },
        limit: { type: "number", default: 10 },
        query: { type: "string", description: "Optional user text used only to infer sort/source" },
      },
    },
    annotations: {
      title: "List newest or latest company files",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  };
}

export function isListCompanyDocumentsTool(name: string): boolean {
  return name === LIST_COMPANY_DOCUMENTS_TOOL;
}

export function withListCompanyDocumentsTool<T extends { name: string }>(tools: T[]): Array<T | ReturnType<typeof listCompanyDocumentsToolDefinition>> {
  if (tools.some((tool) => tool.name === LIST_COMPANY_DOCUMENTS_TOOL)) return tools;
  const hasKnowledge = tools.some((tool) =>
    ["search", "fetch", "search_company_knowledge", "get_knowledge_document", "ask_document"].includes(tool.name),
  );
  if (!hasKnowledge) return tools;
  return [...tools, listCompanyDocumentsToolDefinition()];
}

export function verbaliseCatalogue(data: unknown): string {
  const record = data && typeof data === "object" ? (data as CatalogueResult) : null;
  if (!record?.documents?.length) {
    return "I don’t have any visible OneDrive, SharePoint, or Drive files to list from indexed metadata.";
  }
  const lines = record.documents.map((doc, index) => {
    const when =
      record.sortField === "modified_at"
        ? doc.modified_at
        : record.sortField === "indexed_at"
          ? doc.indexed_at
          : doc.created_at;
    return `${index + 1}. ${doc.title} (${doc.source}${when ? `, ${when.slice(0, 10)}` : ""})\n   ${doc.description}${
      doc.url ? `\n   ${doc.url}` : ""
    }`;
  });
  return `${record.note}\n\n${lines.join("\n")}`;
}
