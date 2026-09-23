/**
 * Elvex knowledge search/fetch via existing EL Business MCP file tools.
 * INFRA does not copy Drive credentials. Does not invent documents.
 */

import { isElvexCompany } from "@infra/shared";
import type { Env } from "../env";
import { callMcpTool, listMcpTools } from "./mcp-client";
import {
  mapFetchArgumentsForCompanyMcp,
  toStandardFetchPayload,
  toStandardSearchPayload,
  type StandardFetchPayload,
  type StandardSearchPayload,
} from "./mcp-knowledge-standard";

export const ELVEX_FILE_SEARCH_TOOL = "search_elvex_files";
export const ELVEX_FILE_GET_TOOL = "get_elvex_file";

const KNOWLEDGE_SEARCH_TOOLS = new Set([
  "search",
  "search_company_knowledge",
  ELVEX_FILE_SEARCH_TOOL,
]);

const KNOWLEDGE_READ_TOOLS = new Set([
  "fetch",
  "get_knowledge_document",
  ELVEX_FILE_GET_TOOL,
]);

export function isElvexKnowledgeInfraTool(toolName: string): boolean {
  return KNOWLEDGE_SEARCH_TOOLS.has(toolName) || KNOWLEDGE_READ_TOOLS.has(toolName);
}

export function isElvexFileSearchTool(toolName: string): boolean {
  return KNOWLEDGE_SEARCH_TOOLS.has(toolName);
}

export function isElvexFileReadTool(toolName: string): boolean {
  return KNOWLEDGE_READ_TOOLS.has(toolName);
}

export function shouldExecuteElvexKnowledgeViaElFiles(
  companyId: string,
  toolName: string,
): boolean {
  return isElvexCompany({ id: companyId }) && isElvexKnowledgeInfraTool(toolName);
}

export function resolveElMcpKnowledgeToolName(
  infraToolName: string,
  listedNames: readonly string[],
): string {
  if (isElvexFileReadTool(infraToolName)) {
    if (listedNames.includes(ELVEX_FILE_GET_TOOL)) return ELVEX_FILE_GET_TOOL;
    if (listedNames.includes("get_knowledge_document")) return "get_knowledge_document";
    return ELVEX_FILE_GET_TOOL;
  }
  if (listedNames.includes(ELVEX_FILE_SEARCH_TOOL)) return ELVEX_FILE_SEARCH_TOOL;
  if (listedNames.includes("search_company_knowledge")) return "search_company_knowledge";
  return ELVEX_FILE_SEARCH_TOOL;
}

export function mapArgumentsForElFileTool(
  elToolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (elToolName === ELVEX_FILE_GET_TOOL || elToolName === "get_knowledge_document") {
    const id = String(
      args.id ?? args.documentRef ?? args.document_id ?? args.documentId ?? args.fileId ?? args.file_id ?? "",
    ).trim();
    const title = typeof args.title === "string" ? args.title.trim() : "";
    return {
      ...mapFetchArgumentsForCompanyMcp(id),
      fileId: id || undefined,
      file_id: id || undefined,
      ...(title ? { title, name: title, filename: title } : {}),
    };
  }
  const query = String(args.query ?? args.q ?? "").trim();
  return {
    query,
    q: query,
    limit: args.limit != null ? Number(args.limit) : undefined,
  };
}

function parsePayload(textContent: string | null, rawResult: unknown): unknown {
  if (textContent) {
    try {
      return JSON.parse(textContent);
    } catch {
      return { text: textContent };
    }
  }
  return rawResult;
}

export function searchLooksEmpty(payload: StandardSearchPayload): boolean {
  return payload.results.length === 0;
}

export function fetchLooksEmpty(payload: StandardFetchPayload): boolean {
  return !payload.text && !(payload.chunks?.length);
}

export type ElvexKnowledgeExecution =
  | {
      ok: true;
      result: StandardSearchPayload | StandardFetchPayload;
      latencyMs: number;
      elToolName: string;
      fallbackUsed: boolean;
    }
  | { ok: false; status: 502 | 503; error: string; code: string };

export async function executeElvexKnowledgeViaElFiles(
  env: Env,
  input: {
    companyId: string;
    mcp: {
      endpointUrl: string;
      authSecretRef?: string | null;
      serviceBindingRef?: string | null;
    };
    toolName: string;
    arguments?: Record<string, unknown>;
  },
): Promise<ElvexKnowledgeExecution> {
  const started = Date.now();
  const args = input.arguments ?? {};
  const wantFetch = isElvexFileReadTool(input.toolName);

  let listedNames: string[] = [];
  try {
    const listed = await listMcpTools(
      env,
      input.mcp.endpointUrl,
      input.mcp.authSecretRef,
      input.mcp.serviceBindingRef,
    );
    listedNames = listed.tools.map((tool) => tool.name);
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: error instanceof Error ? error.message : "EL MCP tools/list failed",
      code: "EL_MCP_UNAVAILABLE",
    };
  }

  const preferred = resolveElMcpKnowledgeToolName(input.toolName, listedNames);
  const fallback = wantFetch
    ? listedNames.includes("get_knowledge_document") && preferred !== "get_knowledge_document"
      ? "get_knowledge_document"
      : null
    : listedNames.includes("search_company_knowledge") && preferred !== "search_company_knowledge"
      ? "search_company_knowledge"
      : null;

  const tryTool = async (elToolName: string) => {
    const execution = await callMcpTool(env, {
      endpointUrl: input.mcp.endpointUrl,
      authSecretRef: input.mcp.authSecretRef,
      serviceBindingRef: input.mcp.serviceBindingRef,
      toolName: elToolName,
      arguments: mapArgumentsForElFileTool(elToolName, args),
    });
    const parsed = parsePayload(execution.textContent, execution.result);
    if (wantFetch) {
      const requestedId = String(args.id ?? args.documentRef ?? "").trim();
      return toStandardFetchPayload(parsed, requestedId);
    }
    return toStandardSearchPayload(parsed);
  };

  try {
    if (!listedNames.includes(preferred)) {
      if (!fallback) {
        return {
          ok: false,
          status: 502,
          error: `EL MCP does not expose a file tool for ${input.toolName}`,
          code: "EL_MCP_FILE_TOOL_MISSING",
        };
      }
      const result = await tryTool(fallback);
      return {
        ok: true,
        result,
        latencyMs: Date.now() - started,
        elToolName: fallback,
        fallbackUsed: true,
      };
    }

    let result = await tryTool(preferred);
    let used = preferred;
    let fallbackUsed = false;
    const empty = wantFetch
      ? fetchLooksEmpty(result as StandardFetchPayload)
      : searchLooksEmpty(result as StandardSearchPayload);
    if (empty && fallback) {
      const retried = await tryTool(fallback);
      const retryEmpty = wantFetch
        ? fetchLooksEmpty(retried as StandardFetchPayload)
        : searchLooksEmpty(retried as StandardSearchPayload);
      if (!retryEmpty) {
        result = retried;
        used = fallback;
        fallbackUsed = true;
      }
    }

    return {
      ok: true,
      result,
      latencyMs: Date.now() - started,
      elToolName: used,
      fallbackUsed,
    };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: error instanceof Error ? error.message : "EL MCP file tool failed",
      code: "EL_MCP_FILE_TOOL_FAILED",
    };
  }
}

export type ElvexCatalogueFile = {
  id: string;
  title: string;
  source: string;
  url: string | null;
  created_at: string | null;
  modified_at: string | null;
  description: string;
};

export function catalogueFilesFromSearchPayload(
  payload: StandardSearchPayload,
): ElvexCatalogueFile[] {
  return payload.results.map((hit) => {
    const meta = hit.metadata ?? {};
    const created = firstTime(meta.createdAt, meta.created_at, meta.createdTime);
    const modified = firstTime(
      meta.modifiedAt,
      meta.modified_at,
      meta.updatedAt,
      meta.updated_at,
      meta.driveModifiedTime,
    );
    return {
      id: hit.id,
      title: hit.title,
      source: String(meta.source ?? meta.source_type ?? meta.sourceType ?? "drive"),
      url: hit.url || null,
      created_at: created,
      modified_at: modified,
      description: hit.snippet ?? "",
    };
  });
}

function firstTime(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}
