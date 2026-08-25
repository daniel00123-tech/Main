import type {
  ConnectorInstance,
  KnowledgeSourceSummary,
  McpEnvironment,
} from "@infra/shared";
import {
  emptyKnowledgeSource,
  knowledgeSourceKindFromConnector,
  mcpHasKnowledgeTools,
} from "@infra/shared";

/**
 * INFRA shows source-level health from control-plane metadata.
 * The corpus stays on the company Business MCP.
 */
export function buildKnowledgeSources(input: {
  mcp: McpEnvironment | null;
  connectors: ConnectorInstance[];
}): KnowledgeSourceSummary[] {
  const { mcp, connectors } = input;
  const sources: KnowledgeSourceSummary[] = [];
  const knowledgeConnectors = connectors.filter((item) =>
    ["conn_google_drive", "conn_onedrive", "conn_sharepoint"].includes(
      item.connectorDefinitionId,
    ),
  );

  for (const connector of knowledgeConnectors) {
    const kind = knowledgeSourceKindFromConnector(connector.connectorDefinitionId);
    sources.push(
      emptyKnowledgeSource({
        sourceKey: connector.id,
        displayName: connector.name,
        kind,
        documentCount: mcp?.knowledgeDocumentCount ?? null,
        chunkCount: mcp?.knowledgeChunkCount ?? null,
        lastSyncAt: connector.lastSuccessfulSyncAt ?? connector.lastSyncAt ?? mcp?.lastSyncAt ?? null,
        lastSuccessfulSyncAt: connector.lastSuccessfulSyncAt ?? null,
        lastError: connector.lastErrorMessage ?? null,
        health:
          connector.healthStatus === "healthy"
            ? "healthy"
            : connector.healthStatus === "degraded"
              ? "degraded"
              : connector.healthStatus === "unhealthy"
                ? "unavailable"
                : "unknown",
        managedBy: connector.managedBy ?? "company_mcp",
      }),
    );
  }

  if (
    sources.length === 0 &&
    mcp &&
    (mcpHasKnowledgeTools(mcp.capabilities) || (mcp.knowledgeDocumentCount ?? 0) > 0)
  ) {
    sources.push(
      emptyKnowledgeSource({
        sourceKey: `${mcp.id}:knowledge`,
        displayName: "Company knowledge",
        kind: "other",
        documentCount: mcp.knowledgeDocumentCount,
        chunkCount: mcp.knowledgeChunkCount,
        lastSyncAt: mcp.lastSyncAt,
        health: (mcp.knowledgeDocumentCount ?? 0) > 0 ? "healthy" : "unknown",
        managedBy: "company_mcp",
      }),
    );
  }

  return sources;
}
