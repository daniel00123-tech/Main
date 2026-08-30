/**
 * ChatGPT Company Knowledge adaptors for the INFRA MCP facade.
 *
 * `search` and `fetch` are INFRA-native, read-only aliases over the company
 * MCP knowledge tools. They do not own a corpus and are not tenant-specific.
 * Tenant routing stays on the authenticated identity (ADR 001).
 *
 * Eligibility for ChatGPT Company Knowledge / File Search is based on the
 * standard tool names and input signatures (`query` / `id`).
 */

export const STANDARD_SEARCH_TOOL = "search";
export const STANDARD_FETCH_TOOL = "fetch";
export const COMPANY_KNOWLEDGE_SEARCH_TOOL = "search_company_knowledge";
export const COMPANY_KNOWLEDGE_READ_TOOL = "get_knowledge_document";

export const READ_ONLY_MCP_TOOLS = [
  "system_health",
  "database_summary",
  COMPANY_KNOWLEDGE_SEARCH_TOOL,
  COMPANY_KNOWLEDGE_READ_TOOL,
  STANDARD_SEARCH_TOOL,
  STANDARD_FETCH_TOOL,
] as const;

export type ReadOnlyMcpTool = (typeof READ_ONLY_MCP_TOOLS)[number];

/** MCP ToolAnnotations for retrieval tools that never mutate state. */
export const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export type McpToolAnnotations = typeof READ_ONLY_TOOL_ANNOTATIONS & {
  title?: string;
};

export const STANDARD_SEARCH_INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      description:
        "Natural-language query over this company's indexed knowledge (policies, processes, and other documents).",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

export const STANDARD_FETCH_INPUT_SCHEMA = {
  type: "object",
  properties: {
    id: {
      type: "string",
      minLength: 1,
      description:
        "Stable document identifier returned by search. Used to retrieve that document's content for citation.",
    },
  },
  required: ["id"],
  additionalProperties: false,
} as const;

export const STANDARD_SEARCH_DESCRIPTION =
  "Search this company's knowledge for policies, processes, and other indexed documents. Use a natural-language query. Returns matching documents with stable ids so you can call fetch. Read-only.";

export const STANDARD_FETCH_DESCRIPTION =
  "Fetch the full content of a company knowledge document previously returned by search. Pass the document id. Read-only. Use the returned url and metadata for source attribution when present.";

const ANNOTATION_TITLES: Record<ReadOnlyMcpTool, string> = {
  search: "Company knowledge search",
  fetch: "Company knowledge document",
  search_company_knowledge: "Company knowledge search",
  get_knowledge_document: "Company knowledge document",
  system_health: "System health",
  database_summary: "Database summary",
};

export function isReadOnlyMcpTool(name: string): name is ReadOnlyMcpTool {
  return (READ_ONLY_MCP_TOOLS as readonly string[]).includes(name);
}

export function annotationsForTool(name: string): McpToolAnnotations | undefined {
  if (!isReadOnlyMcpTool(name)) return undefined;
  return {
    title: ANNOTATION_TITLES[name],
    ...READ_ONLY_TOOL_ANNOTATIONS,
  };
}

/** Map INFRA-standard tool names to the company MCP tool that owns retrieval. */
export function resolveCompanyMcpToolName(toolName: string): string {
  if (toolName === STANDARD_SEARCH_TOOL) return COMPANY_KNOWLEDGE_SEARCH_TOOL;
  if (toolName === STANDARD_FETCH_TOOL) return COMPANY_KNOWLEDGE_READ_TOOL;
  return toolName;
}

export function isStandardKnowledgeTool(toolName: string): boolean {
  return (
    toolName === STANDARD_SEARCH_TOOL || toolName === STANDARD_FETCH_TOOL
  );
}

export type StandardSearchResult = {
  id: string;
  title: string;
  url: string;
  snippet?: string;
  metadata?: Record<string, unknown>;
};

export type StandardSearchPayload = {
  results: StandardSearchResult[];
};

export type StandardDocumentChunk = {
  id?: string;
  text: string;
  heading?: string;
  index?: number;
};

export type StandardFetchPayload = {
  id: string;
  title: string;
  text: string;
  url: string;
  metadata?: Record<string, unknown>;
  chunks?: StandardDocumentChunk[];
};

export function sanitizeStandardSearchArguments(
  args: Record<string, unknown>,
): { query: string } | { error: string } {
  const query =
    typeof args.query === "string"
      ? args.query.trim()
      : typeof args.q === "string"
        ? args.q.trim()
        : "";
  if (!query) {
    return { error: "search requires a non-empty arguments.query string" };
  }
  return { query };
}

export function sanitizeStandardFetchArguments(
  args: Record<string, unknown>,
): { id: string } | { error: string } {
  const id =
    typeof args.id === "string"
      ? args.id.trim()
      : typeof args.documentId === "string"
        ? args.documentId.trim()
        : typeof args.document_id === "string"
          ? args.document_id.trim()
          : "";
  if (!id) {
    return { error: "fetch requires a non-empty arguments.id string" };
  }
  return { id };
}

/**
 * Arguments forwarded to the company MCP knowledge-read tool.
 * ChatGPT Company Knowledge always sends `id`. Company MCPs may require
 * `documentRef` (numeric document id or external_id) or `id`.
 * Send both so the same adaptor works for every tenant.
 */
export function mapFetchArgumentsForCompanyMcp(id: string): Record<string, unknown> {
  return { documentRef: id, id };
}

const PROVIDER_URL_KEYS = [
  "url",
  "sourceUrl",
  "source_url",
  "webUrl",
  "web_url",
  "webViewLink",
  "web_view_link",
  "webContentLink",
  "web_content_link",
  "webLink",
  "web_link",
  "alternateLink",
  "alternate_link",
  "canonicalUrl",
  "canonical_url",
] as const;

export function firstHttpUrl(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Parse a JSON object that company MCPs often store as a string (D1 metadata). */
export function parseMaybeJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function urlFromRecordFields(source: Record<string, unknown> | undefined): string {
  if (!source) return "";
  return firstHttpUrl(...PROVIDER_URL_KEYS.map((key) => source[key]));
}

/**
 * Collect a genuine provider HTTPS URL. Never constructs Drive/SharePoint links
 * from file IDs — only copies http(s) fields the provider already returned.
 */
export function collectProviderHttpUrl(...sources: unknown[]): string {
  for (const source of sources) {
    if (typeof source === "string") {
      const direct = firstHttpUrl(source);
      if (direct) return direct;
      const parsed = parseMaybeJsonRecord(source);
      const fromParsed = urlFromRecordFields(parsed);
      if (fromParsed) return fromParsed;
      continue;
    }
    if (!isRecord(source)) continue;
    const direct = urlFromRecordFields(source);
    if (direct) return direct;
    const nested = [
      parseMaybeJsonRecord(source.metadata),
      parseMaybeJsonRecord(source.provenance),
      parseMaybeJsonRecord(source.document),
      isRecord(source.document) ? parseMaybeJsonRecord(source.document.metadata) : undefined,
      isRecord(source.provenance) ? parseMaybeJsonRecord(source.provenance.metadata) : undefined,
    ];
    for (const item of nested) {
      const url = urlFromRecordFields(item);
      if (url) return url;
    }
  }
  return "";
}

export function unwrapToolPayload(payload: unknown, depth = 0): unknown {
  if (depth > 6 || payload == null) return payload;
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (!trimmed) return payload;
    try {
      return unwrapToolPayload(JSON.parse(trimmed), depth + 1);
    } catch {
      return payload;
    }
  }
  if (!isRecord(payload)) return payload;

  if (Array.isArray(payload.content)) {
    const textItem = payload.content.find(
      (item) =>
        isRecord(item) && item.type === "text" && typeof item.text === "string",
    );
    if (textItem && typeof textItem.text === "string") {
      const parsed = unwrapToolPayload(textItem.text, depth + 1);
      if (parsed && typeof parsed === "object") return parsed;
    }
  }

  if (isRecord(payload.structuredContent)) {
    return unwrapToolPayload(payload.structuredContent, depth + 1);
  }

  if (isRecord(payload.result) || Array.isArray(payload.result)) {
    return unwrapToolPayload(payload.result, depth + 1);
  }

  if (isRecord(payload.data)) {
    const data = payload.data;
    if (data.results || data.text || data.title || data.content || data.id) {
      return data;
    }
    if (isRecord(data.result) || Array.isArray(data.result)) {
      return unwrapToolPayload(data.result, depth + 1);
    }
  }

  return payload;
}

function asNonEmptyString(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function asIdString(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return asNonEmptyString(value);
}

function pickSnippet(hit: Record<string, unknown>): string | undefined {
  const snippet = asNonEmptyString(
    hit.excerpt ??
      hit.snippet ??
      hit.text ??
      hit.summary ??
      hit.content ??
      hit.preview,
  );
  return snippet || undefined;
}

function pickTitle(hit: Record<string, unknown>, fallback = "Untitled document"): string {
  return (
    asNonEmptyString(
      hit.title ??
        hit.name ??
        hit.filename ??
        hit.documentTitle ??
        hit.document_title,
    ) || fallback
  );
}

function pickId(hit: Record<string, unknown>, fallback = ""): string {
  return (
    asIdString(hit.id) ||
    asIdString(hit.externalId) ||
    asIdString(hit.external_id) ||
    asIdString(hit.documentId) ||
    asIdString(hit.document_id) ||
    asIdString(hit.docId) ||
    asIdString(hit.doc_id) ||
    fallback
  );
}

function provenanceMetadata(
  source: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  const keys = [
    "source",
    "sourceType",
    "source_type",
    "filename",
    "mimeType",
    "mime_type",
    "score",
    "path",
    "documentId",
    "document_id",
    "externalId",
    "external_id",
    "driveFileId",
    "drive_file_id",
    "modifiedAt",
    "modified_at",
    "updatedAt",
    "updated_at",
    "webViewLink",
    "webContentLink",
    "webUrl",
    "web_url",
  ] as const;
  for (const key of keys) {
    if (source[key] != null && source[key] !== "") {
      metadata[key] = source[key];
    }
  }
  const nestedMetadata = parseMaybeJsonRecord(source.metadata);
  if (nestedMetadata) {
    for (const [key, value] of Object.entries(nestedMetadata)) {
      if (value != null && value !== "" && metadata[key] == null) {
        metadata[key] = value;
      }
    }
  }
  return Object.keys(metadata).length ? metadata : undefined;
}

export function extractHitList(payload: unknown): Record<string, unknown>[] {
  const unwrapped = unwrapToolPayload(payload);
  if (Array.isArray(unwrapped)) {
    return unwrapped.filter(isRecord);
  }
  if (!isRecord(unwrapped)) return [];
  const list =
    unwrapped.results ??
    unwrapped.matches ??
    unwrapped.documents ??
    unwrapped.hits ??
    unwrapped.items;
  return Array.isArray(list) ? list.filter(isRecord) : [];
}

export function toStandardSearchPayload(payload: unknown): StandardSearchPayload {
  const results: StandardSearchResult[] = [];
  for (const hit of extractHitList(payload)) {
    const parsedHitMetadata = parseMaybeJsonRecord(hit.metadata);
    if (parsedHitMetadata) hit.metadata = parsedHitMetadata;
    const title = pickTitle(hit);
    const id = pickId(hit, title);
    if (!id) continue;
    const url = collectProviderHttpUrl(hit, parsedHitMetadata, hit.provenance);
    const snippet = pickSnippet(hit);
    const metadata = provenanceMetadata(hit);
    const result: StandardSearchResult = { id, title, url };
    if (snippet) result.snippet = snippet;
    if (metadata) result.metadata = metadata;
    results.push(result);
  }
  return { results };
}

export function collectDocumentChunks(
  payload: unknown,
  documentId?: string,
): StandardDocumentChunk[] {
  const unwrapped = unwrapToolPayload(payload);
  const nestedRaw = isRecord(unwrapped) ? unwrapped.document : undefined;
  const nested = parseMaybeJsonRecord(nestedRaw) ?? (isRecord(nestedRaw) ? nestedRaw : {});
  const doc = isRecord(unwrapped) ? { ...unwrapped, ...nested } : {};
  const rawChunks = Array.isArray(doc.chunks)
    ? doc.chunks
    : isRecord(unwrapped) && Array.isArray(unwrapped.chunks)
      ? unwrapped.chunks
      : [];
  const id = documentId || pickId(doc) || "document";
  const chunks: StandardDocumentChunk[] = [];
  rawChunks.forEach((chunk, index) => {
    if (typeof chunk === "string") {
      const text = chunk.trim();
      if (text) chunks.push({ id: `${id}:c${index}`, text, index });
      return;
    }
    if (!isRecord(chunk)) return;
    const text = asNonEmptyString(chunk.text ?? chunk.content ?? chunk.excerpt ?? chunk.body);
    if (!text) return;
    const heading = asNonEmptyString(chunk.heading ?? chunk.title ?? chunk.section);
    const chunkId = asNonEmptyString(chunk.id ?? chunk.chunk_id ?? chunk.chunkId) || `${id}:c${index}`;
    chunks.push({
      id: chunkId,
      text,
      heading: heading || undefined,
      index: typeof chunk.index === "number" ? chunk.index : index,
    });
  });
  return chunks;
}

function collectDocumentText(doc: Record<string, unknown>): string {
  const direct = asNonEmptyString(
    doc.text ?? doc.content ?? doc.body ?? doc.fullText ?? doc.full_text,
  );

  if (Array.isArray(doc.chunks)) {
    const joined = doc.chunks
      .map((chunk) => {
        if (typeof chunk === "string") return chunk;
        if (!isRecord(chunk)) return "";
        return asNonEmptyString(chunk.text ?? chunk.content ?? chunk.excerpt);
      })
      .filter(Boolean)
      .join("\n\n");
    if (joined && joined.length >= (direct?.length ?? 0)) return joined;
  }

  if (direct) return direct;

  if (Array.isArray(doc.pages)) {
    const joined = doc.pages
      .map((page) => {
        if (typeof page === "string") return page;
        if (!isRecord(page)) return "";
        return asNonEmptyString(page.text ?? page.content);
      })
      .filter(Boolean)
      .join("\n\n");
    if (joined) return joined;
  }

  const snippet = pickSnippet(doc);
  return snippet ?? "";
}

export function toStandardFetchPayload(
  payload: unknown,
  requestedId: string,
): StandardFetchPayload {
  const unwrapped = unwrapToolPayload(payload);
  const nestedRaw = isRecord(unwrapped) ? unwrapped.document : undefined;
  const nested = parseMaybeJsonRecord(nestedRaw) ?? (isRecord(nestedRaw) ? nestedRaw : {});
  const doc = isRecord(unwrapped) ? { ...unwrapped, ...nested } : {};
  const parsedDocMetadata = parseMaybeJsonRecord(doc.metadata);
  if (parsedDocMetadata) doc.metadata = parsedDocMetadata;

  const id =
    requestedId ||
    pickId(doc) ||
    pickId(nested);
  const title = pickTitle(doc, "Untitled document");
  const text = collectDocumentText(doc);
  const url = collectProviderHttpUrl(
    doc,
    nested,
    unwrapped,
    parsedDocMetadata,
    isRecord(unwrapped) ? unwrapped.metadata : undefined,
    isRecord(unwrapped) ? unwrapped.provenance : undefined,
  );
  const metadata = provenanceMetadata({
    ...(isRecord(unwrapped) ? unwrapped : {}),
    ...nested,
    ...doc,
    ...(parsedDocMetadata ?? {}),
  });

  const chunks = collectDocumentChunks(payload, id);
  const result: StandardFetchPayload = { id, title, text, url };
  if (metadata) result.metadata = metadata;
  if (chunks.length) result.chunks = chunks;
  return result;
}

export function wrapStandardToolResult(
  payload: StandardSearchPayload | StandardFetchPayload,
): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: StandardSearchPayload | StandardFetchPayload;
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload),
      },
    ],
    structuredContent: payload,
  };
}

export type AdvertisedMcpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
};

export function standardSearchToolDefinition(): AdvertisedMcpTool {
  return {
    name: STANDARD_SEARCH_TOOL,
    description: STANDARD_SEARCH_DESCRIPTION,
    inputSchema: { ...STANDARD_SEARCH_INPUT_SCHEMA },
    annotations: annotationsForTool(STANDARD_SEARCH_TOOL),
  };
}

export function standardFetchToolDefinition(): AdvertisedMcpTool {
  return {
    name: STANDARD_FETCH_TOOL,
    description: STANDARD_FETCH_DESCRIPTION,
    inputSchema: { ...STANDARD_FETCH_INPUT_SCHEMA },
    annotations: annotationsForTool(STANDARD_FETCH_TOOL),
  };
}

/**
 * Inject `search` / `fetch` when the underlying company knowledge tools are
 * already advertised to this actor, and attach read-only annotations.
 */
export function withStandardKnowledgeTools(
  tools: AdvertisedMcpTool[],
): AdvertisedMcpTool[] {
  const names = new Set(tools.map((tool) => tool.name));
  const extras: AdvertisedMcpTool[] = [];
  if (names.has(COMPANY_KNOWLEDGE_SEARCH_TOOL) && !names.has(STANDARD_SEARCH_TOOL)) {
    extras.push(standardSearchToolDefinition());
  }
  if (names.has(COMPANY_KNOWLEDGE_READ_TOOL) && !names.has(STANDARD_FETCH_TOOL)) {
    extras.push(standardFetchToolDefinition());
  }

  return [...extras, ...tools].map((tool) => {
    const annotations = annotationsForTool(tool.name);
    return annotations ? { ...tool, annotations } : tool;
  });
}
