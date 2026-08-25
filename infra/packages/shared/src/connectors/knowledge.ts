import type { KnowledgeSourceKind, KnowledgeSourceSummary } from "../types";

export const KNOWLEDGE_SEARCH_TOOL = "search_company_knowledge";
export const KNOWLEDGE_READ_TOOL = "get_knowledge_document";
export const STANDARD_KNOWLEDGE_SEARCH_TOOL = "search";
export const STANDARD_KNOWLEDGE_FETCH_TOOL = "fetch";

export const KNOWLEDGE_TOOLS = [KNOWLEDGE_SEARCH_TOOL, KNOWLEDGE_READ_TOOL] as const;

export function mcpHasKnowledgeTools(tools: string[] | undefined | null): boolean {
  const list = tools ?? [];
  return list.includes(KNOWLEDGE_SEARCH_TOOL) || list.includes(KNOWLEDGE_READ_TOOL);
}

export function knowledgeSourceKindFromConnector(
  definitionId: string | null | undefined,
): KnowledgeSourceKind {
  switch (definitionId) {
    case "conn_google_drive":
      return "google_drive";
    case "conn_onedrive":
      return "onedrive";
    case "conn_sharepoint":
      return "sharepoint";
    default:
      return "other";
  }
}

export function formatUnavailableTimestamp(value: string | null | undefined): string {
  return value ?? "Unavailable";
}

/** Control-plane view of one knowledge source. Corpus stays on the company MCP. */
export function emptyKnowledgeSource(
  overrides: Partial<KnowledgeSourceSummary> &
    Pick<KnowledgeSourceSummary, "sourceKey" | "displayName" | "kind">,
): KnowledgeSourceSummary {
  return {
    documentCount: null,
    chunkCount: null,
    lastSyncAt: null,
    lastSuccessfulSyncAt: null,
    lastError: null,
    health: "unknown",
    managedBy: "company_mcp",
    ...overrides,
  };
}
