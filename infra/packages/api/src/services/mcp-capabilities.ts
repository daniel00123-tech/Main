import type {
  CapabilitySnapshot,
  McpEnvironment,
  McpOnboardingStatus,
} from "@infra/shared";
import { mcpHasKnowledgeTools } from "@infra/shared";
import { buildCapabilitySnapshot, snapshotFromMcp } from "./capability-snapshot";

/** Baseline tools INFRA understands when a Business MCP reports them. */
export const BUSINESS_MCP_BASELINE_TOOLS = [
  "system_health",
  "database_summary",
  "search_company_knowledge",
  "get_knowledge_document",
] as const;

export interface DiscoveredMcpCapabilities {
  knowledge: "configured" | "not_configured";
  structuredData: "configured" | "not_configured";
  writes: "supported" | "not_supported";
  connectors: string[];
  tools: string[];
  version: string | null;
  coreVersion: string | null;
  snapshot: CapabilitySnapshot | null;
}

export function deriveMcpOnboardingStatus(
  mcp: McpEnvironment | null | undefined,
): McpOnboardingStatus {
  if (!mcp) return "not_provisioned";
  if (!mcp.authSecretRef) return "authentication_required";
  if (mcp.status === "disabled") return "offline";
  if (mcp.status === "unreachable") return "offline";
  if (mcp.status === "degraded") return "degraded";
  if (mcp.status === "healthy") return "healthy";
  if (mcp.lastSuccessfulRequestAt) return "connected";
  return "registered";
}

export function discoverMcpCapabilities(
  mcp: McpEnvironment | null | undefined,
): DiscoveredMcpCapabilities {
  const tools = mcp?.capabilities ?? [];
  const snapshot = snapshotFromMcp(mcp ?? null);
  const knowledge =
    (mcp?.knowledgeDocumentCount ?? 0) > 0 || mcpHasKnowledgeTools(tools)
      ? "configured"
      : "not_configured";
  const structuredData = tools.some((name) =>
    /warehouse|database_summary|query_business|entity/i.test(name),
  )
    ? "configured"
    : "not_configured";
  const writes = tools.some((name) =>
    /create_|update_|delete_|write_|raise_|send_/i.test(name),
  )
    ? "supported"
    : "not_supported";

  return {
    knowledge,
    structuredData,
    writes,
    connectors: tools.filter((name) => /connector|sync|xero|drive|sharepoint/i.test(name)),
    tools,
    version: mcp?.mcpVersion ?? null,
    coreVersion: mcp?.businessMcpCoreVersion ?? null,
    snapshot,
  };
}

export function capabilitySnapshotFromTools(
  tools: string[],
  mcp?: McpEnvironment | null,
): CapabilitySnapshot {
  return buildCapabilitySnapshot({
    tools,
    version: mcp?.mcpVersion,
    coreVersion: mcp?.businessMcpCoreVersion,
    knowledgeDocumentCount: mcp?.knowledgeDocumentCount,
  });
}
