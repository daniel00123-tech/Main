import type {
  AuditEvent,
  Company,
  CompanyOverview,
  CompanyRole,
  ConnectorDefinition,
  ConnectorInstance,
  InfraUser,
  McpEnvironment,
  ToolAction,
} from "@infra/shared";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export interface SessionUser {
  userId: string;
  email: string;
  displayName: string;
  isPlatformAdmin: boolean;
  memberships: Array<{
    companyId: string;
    role: CompanyRole;
  }>;
}

export interface PlatformSummary {
  companies: number;
  mcpEnvironments: number;
  healthyMcp: number;
  connectorInstances: number;
  activeConnectors: number;
  recentAuditEvents: AuditEvent[];
}

export interface RolePresetResponse {
  role: CompanyRole;
  displayName: string;
  description: string;
  allowedActions: ToolAction[];
  deniedByDefault: ToolAction[];
}

async function fetchJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    let message = `Request failed: ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // ignore parse errors
    }
    throw new Error(message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export const api = {
  login: (email: string, password: string) =>
    fetchJson<SessionUser>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: () =>
    fetchJson<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  getSession: () => fetchJson<SessionUser>("/api/auth/me"),
  validatePasswordSetupToken: (token: string) =>
    fetchJson<{
      valid: boolean;
      maskedEmail?: string;
      expiresAt?: string;
      purpose?: string;
      error?: string;
    }>(`/api/auth/password-setup/validate?token=${encodeURIComponent(token)}`),
  completePasswordSetup: (token: string, password: string, confirmPassword: string) =>
    fetchJson<{ ok: boolean }>("/api/auth/password-setup", {
      method: "POST",
      body: JSON.stringify({ token, password, confirmPassword }),
    }),
  getSummary: () => fetchJson<PlatformSummary>("/api/summary"),
  getCompanies: () => fetchJson<Company[]>("/api/companies"),
  getCompany: (slug: string) => fetchJson<Company>(`/api/companies/${slug}`),
  getCompanyOverview: (slug: string) =>
    fetchJson<CompanyOverview>(`/api/companies/${slug}/overview`),
  getConnectorCatalogue: () =>
    fetchJson<ConnectorDefinition[]>("/api/connectors/catalogue"),
  getMcpEnvironments: (companyId?: string) => {
    const query = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
    return fetchJson<McpEnvironment[]>(`/api/mcp-environments${query}`);
  },
  getConnectorInstances: (companyId?: string) => {
    const query = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
    return fetchJson<ConnectorInstance[]>(`/api/connector-instances${query}`);
  },
  getAuditEvents: (companyId?: string, limit = 50) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (companyId) params.set("companyId", companyId);
    return fetchJson<AuditEvent[]>(`/api/audit-events?${params.toString()}`);
  },
  getUsers: (companyId?: string) => {
    const query = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
    return fetchJson<InfraUser[]>(`/api/users${query}`);
  },
  getRolePresets: () => fetchJson<RolePresetResponse[]>("/api/roles/presets"),
  runMcpHealthCheck: (id: string) =>
    fetchJson<Record<string, unknown>>(`/api/mcp-environments/${id}/health-check`, {
      method: "POST",
    }),
};
