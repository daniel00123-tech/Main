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
  UsageRecord,
  UsageSummary,
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

export interface CompanyUsageResponse {
  companyId: string;
  summary: UsageSummary;
  records: UsageRecord[];
}

export interface McpExecuteResult {
  correlationId: string;
  mcpId: string;
  companyId: string;
  toolName: string;
  latencyMs: number;
  authConfigured: boolean;
  riskClass: string;
  result: unknown;
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
  getCompanyUsage: (slug: string, limit = 50) =>
    fetchJson<CompanyUsageResponse>(
      `/api/companies/${slug}/usage?limit=${encodeURIComponent(String(limit))}`,
    ),
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
  getMcpAllowedTools: (id: string) =>
    fetchJson<Array<{ toolName: string; riskClass: string; enabled: boolean }>>(
      `/api/mcp-environments/${id}/allowed-tools`,
    ),
  executeMcpTool: (
    id: string,
    toolName: string,
    args?: Record<string, unknown>,
  ) =>
    fetchJson<McpExecuteResult>(`/api/mcp-environments/${id}/execute`, {
      method: "POST",
      body: JSON.stringify({ toolName, arguments: args ?? {} }),
    }),
  getWallet: (slug: string) =>
    fetchJson<{
      wallet: {
        companyId: string;
        balanceCents: number;
        currency: string;
        lowBalanceThresholdCents: number;
        lowBalance: boolean;
        stripeCustomerId: string | null;
        updatedAt: string;
      };
      ledger: Array<{
        id: string;
        entryType: string;
        amountCents: number;
        balanceAfterCents: number;
        description: string | null;
        createdAt: string;
      }>;
      stripeConfigured: boolean;
      topUpOptionsCents: number[];
    }>(`/api/companies/${slug}/wallet`),
  createTopUp: (slug: string, amountCents: number) =>
    fetchJson<Record<string, unknown>>(`/api/companies/${slug}/wallet/top-up`, {
      method: "POST",
      body: JSON.stringify({ amountCents }),
    }),
  getAiConnections: (slug: string) =>
    fetchJson<
      Array<{
        id: string;
        clientType: string;
        displayName: string;
        status: string;
        gatewayEndpoint: string;
        setupNotes: string | null;
        lastUsedAt: string | null;
        serviceIdentityId: string | null;
      }>
    >(`/api/companies/${slug}/ai-connections`),
  connectAiClient: (slug: string, clientType: string) =>
    fetchJson<{
      token: string;
      gatewayEndpoint: string;
      setup: Record<string, unknown>;
      warning: string;
      identity: { id: string; name: string; tokenPrefix: string | null };
    }>(`/api/companies/${slug}/ai-connections/${clientType}/connect`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  inviteUser: (
    slug: string,
    input: { email: string; displayName: string; role: CompanyRole },
  ) =>
    fetchJson<{
      user: { id: string; email: string; displayName: string };
      setupUrl: string;
      setupToken: string;
      setupTokenExpiresAt: string;
    }>(`/api/companies/${slug}/users/invite`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  setUserStatus: (slug: string, userId: string, status: "active" | "disabled") =>
    fetchJson<{ ok: boolean }>(`/api/companies/${slug}/users/${userId}/status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    }),
  setUserRole: (slug: string, userId: string, role: CompanyRole) =>
    fetchJson<{ ok: boolean }>(`/api/companies/${slug}/users/${userId}/role`, {
      method: "POST",
      body: JSON.stringify({ role }),
    }),
  getServiceIdentities: (slug: string) =>
    fetchJson<
      Array<{
        id: string;
        name: string;
        identityType: string;
        status: string;
        tokenPrefix: string | null;
        requestCount: number;
        lastUsedAt: string | null;
        scopes: string[];
      }>
    >(`/api/companies/${slug}/service-identities`),
  getBillingBalances: () =>
    fetchJson<
      Array<{
        companyId: string;
        companyName: string;
        companySlug: string;
        balanceCents: number;
        currency: string;
        lowBalance: boolean;
      }>
    >("/api/billing/balances"),
};

