import type { CapabilitySnapshot, McpEnvironment } from "@infra/shared";
import { mcpHasKnowledgeTools } from "@infra/shared";

export function parseCapabilityList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.map(String);
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { tools?: unknown }).tools)
    ) {
      return ((parsed as { tools: unknown[] }).tools).map(String);
    }
    return [];
  } catch {
    return [];
  }
}

export function buildCapabilitySnapshot(input: {
  tools: string[];
  version?: string | null;
  coreVersion?: string | null;
  knowledgeDocumentCount?: number | null;
  refreshedAt?: string;
}): CapabilitySnapshot {
  const tools = input.tools;
  const knowledgeTools = mcpHasKnowledgeTools(tools);
  const structured = tools.some((name) =>
    /warehouse|database_summary|query_business|entity/i.test(name),
  );
  const writes = tools.some((name) =>
    /create_|update_|delete_|write_|raise_|send_/i.test(name),
  );
  return {
    version: input.version ?? null,
    coreVersion: input.coreVersion ?? null,
    tools,
    groups: {
      system: tools.some((name) => /system_health|initialize|tools\/list/i.test(name)),
      knowledge: knowledgeTools,
      structured_data: structured,
      connectors: tools.some((name) => /connector|xero|drive|sharepoint|freshdesk/i.test(name)),
      writes,
      financial_actions: tools.some((name) =>
        /invoice|payment|purchase_order|credit_note/i.test(name),
      ),
      external_send: tools.some((name) => /send_|whatsapp|email/i.test(name)),
      sync: tools.some((name) => /sync/i.test(name)),
      webhooks: tools.some((name) => /webhook/i.test(name)),
    },
    knowledgeConfigured:
      knowledgeTools && (input.knowledgeDocumentCount ?? 0) > 0,
    structuredDataConfigured: structured,
    writesSupported: writes,
    connectorTypes: tools.filter((name) =>
      /connector|xero|drive|sharepoint|freshdesk|bigchange|commusoft/i.test(name),
    ),
    refreshedAt: input.refreshedAt ?? new Date().toISOString(),
  };
}

export function snapshotFromMcp(mcp: McpEnvironment | null | undefined): CapabilitySnapshot | null {
  if (!mcp) return null;
  if (mcp.capabilitySnapshot) return mcp.capabilitySnapshot;
  return buildCapabilitySnapshot({
    tools: mcp.capabilities ?? [],
    version: mcp.mcpVersion,
    coreVersion: mcp.businessMcpCoreVersion,
    knowledgeDocumentCount: mcp.knowledgeDocumentCount,
    refreshedAt: mcp.capabilityRefreshedAt ?? mcp.lastHealthCheckAt ?? mcp.updatedAt,
  });
}
