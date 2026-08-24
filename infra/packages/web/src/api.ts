import type {
  Company,
  CompanyOverview,
  ConnectorDefinition,
  ConnectorInstance,
  McpEnvironment,
} from "@infra/shared";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export interface PlatformSummary {
  companies: number;
  mcpEnvironments: number;
  healthyMcp: number;
  connectorInstances: number;
  activeConnectors: number;
  recentAuditEvents: Array<{
    id: string;
    eventType: string;
    actor: string;
    createdAt: string;
    detail: Record<string, unknown>;
  }>;
}

export const api = {
  getSummary: () => fetchJson<PlatformSummary>("/api/summary"),
  getCompanies: () => fetchJson<Company[]>("/api/companies"),
  getCompanyOverview: (slug: string) =>
    fetchJson<CompanyOverview>(`/api/companies/${slug}/overview`),
  getConnectorCatalogue: () =>
    fetchJson<ConnectorDefinition[]>("/api/connectors/catalogue"),
  getMcpEnvironments: () => fetchJson<McpEnvironment[]>("/api/mcp-environments"),
  getConnectorInstances: () =>
    fetchJson<ConnectorInstance[]>("/api/connector-instances"),
  runMcpHealthCheck: async (id: string) => {
    const response = await fetch(`${API_BASE}/api/mcp-environments/${id}/health-check`, {
      method: "POST",
    });
    if (!response.ok) throw new Error(`Health check failed: ${response.status}`);
    return response.json();
  },
};
