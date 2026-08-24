import type {
  AuditEvent,
  Company,
  CompanyOverview,
  CompanyRole,
  ConnectorDefinition,
  ConnectorInstance,
  CreateCompanyInput,
  InfraUser,
  McpEnvironment,
  ToolAction,
  UsageRecord,
  UsageSummary,
} from "@infra/shared";

export const API_BASE =
  import.meta.env.VITE_API_BASE ??
  (import.meta.env.PROD
    ? "https://infra-api.daniel-dwyer123.workers.dev"
    : "");

/** ChatGPT / Claude connect here — never to a company MCP. */
export function infraMcpUrl(): string {
  const base = API_BASE.replace(/\/$/, "");
  return `${base}/api/gateway/v1/mcp`;
}

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
  recentUsage?: UsageRecord[];
  permissionDenialsLast24h?: number;
  unhealthyMcp?: number;
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
  getHealth: () =>
    fetchJson<{ status: string; environment?: string; timestamp?: string }>("/health"),
  getReady: () =>
    fetchJson<{
      status: string;
      checks?: Record<string, string>;
      timestamp?: string;
    }>("/ready"),
  getGatewayHealth: () =>
    fetchJson<{
      status: string;
      service?: string;
      version?: string;
      stripeConfigured?: boolean;
    }>("/api/gateway/v1/health"),
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
  createCompany: (input: CreateCompanyInput) =>
    fetchJson<{
      company: Company;
      portalPath: string;
      portalHostname: string | null;
      adminInvite: {
        email: string;
        setupUrl: string;
        expiresAt: string;
      } | null;
    }>("/api/companies", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  setCompanyStatus: (slug: string, status: "active" | "suspended" | "closed") =>
    fetchJson<Company>(`/api/companies/${slug}/status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    }),
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
        referenceType?: string | null;
        referenceId?: string | null;
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
        companyId?: string;
        companyName?: string;
        clientType: string;
        displayName: string;
        status: string;
        gatewayEndpoint: string;
        mcpEndpoint?: string;
        connectionMethod?: string;
        setupNotes: string | null;
        lastUsedAt: string | null;
        lastSuccessfulRequestAt?: string | null;
        serviceIdentityId: string | null;
        serviceIdentityName?: string | null;
        serviceIdentityStatus?: string | null;
        scopes?: string[];
        tokenStatus?: string;
        tokenPrefix?: string | null;
        requestCount?: number;
      }>
    >(`/api/companies/${slug}/ai-connections`),
  connectAiClient: (slug: string, clientType: string) =>
    fetchJson<{
      token: string;
      gatewayEndpoint: string;
      mcpEndpoint?: string;
      setup: Record<string, unknown>;
      warning: string;
      identity: { id: string; name: string; tokenPrefix: string | null };
    }>(`/api/companies/${slug}/ai-connections/${clientType}/connect`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  revokeAiClient: (slug: string, clientType: string) =>
    fetchJson<{ ok: boolean; status: string; clientType: string }>(
      `/api/companies/${slug}/ai-connections/${clientType}/revoke`,
      { method: "POST", body: "{}" },
    ),
  testAiClient: (slug: string, clientType: string) =>
    fetchJson<Record<string, unknown>>(
      `/api/companies/${slug}/ai-connections/${clientType}/test`,
      { method: "POST", body: "{}" },
    ),
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
  getCommercialSummary: () =>
    fetchJson<{
      usage: {
        requests: number;
        successful: number;
        failed: number;
        customerChargesCents: number;
        underlyingCostsCents: number;
        grossProfitCents: number;
        grossMarginBps: number | null;
      };
      policies: Array<Record<string, unknown>>;
      rules: Array<Record<string, unknown>>;
      providerRateCards: Array<Record<string, unknown>>;
      openIntegrityExceptions: number;
    }>("/api/commercial/summary"),
  getCommercialUsage: (params?: {
    companyId?: string;
    sourceClient?: string;
    success?: boolean;
  }) => {
    const q = new URLSearchParams();
    if (params?.companyId) q.set("companyId", params.companyId);
    if (params?.sourceClient) q.set("sourceClient", params.sourceClient);
    if (params?.success === true) q.set("success", "true");
    if (params?.success === false) q.set("success", "false");
    const suffix = q.toString() ? `?${q}` : "";
    return fetchJson<{
      summary: {
        requests: number;
        successful: number;
        failed: number;
        customerChargesCents: number;
        underlyingCostsCents: number;
        grossProfitCents: number;
        grossMarginBps: number | null;
      };
      records: UsageRecord[];
    }>(`/api/commercial/usage${suffix}`);
  },
  getProviderCosts: () =>
    fetchJson<{
      cards: Array<{
        card: {
          id: string;
          provider: string;
          versionLabel: string;
          status: string;
          currency: string;
          sourceUrl: string | null;
          verifiedAt: string | null;
          effectiveFrom: string | null;
          updatedAt: string;
        };
        items: Array<{
          id: string;
          service: string;
          sku: string | null;
          billingUnit: string;
          unitCostMicros: number;
          includedAllowance: number | null;
          notes: string | null;
        }>;
      }>;
      nextReviewNote: string;
    }>("/api/commercial/provider-costs"),
  getPricingRules: () =>
    fetchJson<{
      policies: Array<{
        id: string;
        companyId: string | null;
        targetMarginBps: number;
        minimumChargeCents: number;
        currency: string;
        isTestConfig: boolean;
        enabled: boolean;
        label: string | null;
        effectiveFrom: string;
        effectiveTo: string | null;
      }>;
      rules: Array<{
        id: string;
        companyId: string | null;
        action: string;
        pricingMode: string;
        fixedChargeCents: number | null;
        targetMarginBps: number | null;
        minimumChargeCents: number | null;
        chargeOnFailure: boolean;
        isBillable: boolean;
        label: string | null;
        isTestConfig: boolean;
        enabled: boolean;
        rateCardId: string | null;
        versionLabel: string | null;
        effectiveFrom: string | null;
        effectiveTo: string | null;
      }>;
    }>("/api/commercial/pricing-rules"),
  requestProviderPricingReview: (
    provider: string,
    body?: { sourceUrl?: string; notes?: string },
  ) =>
    fetchJson<{ reviewId: string; status: string }>(
      `/api/commercial/provider-costs/${encodeURIComponent(provider)}/request-review`,
      { method: "POST", body: JSON.stringify(body ?? {}) },
    ),
  getPricingReviews: () =>
    fetchJson<{
      reviews: Array<{
        id: string;
        provider: string;
        status: string;
        sourceUrl: string | null;
        detectedAt: string;
        reviewedBy: string | null;
        reviewNotes: string | null;
      }>;
    }>("/api/commercial/pricing-reviews"),
  runReconciliation: () =>
    fetchJson<{
      detectedAt: string;
      healedLinks?: number;
      healed?: Array<{ usageId: string; ledgerId: string }>;
      exceptionsCreated: number;
      exceptionIds: string[];
      note?: string;
    }>("/api/commercial/reconciliation/run", { method: "POST", body: "{}" }),
  getIntegrityExceptions: (status = "open") =>
    fetchJson<{
      exceptions: Array<{
        id: string;
        companyId: string | null;
        exceptionType: string;
        severity: string;
        status: string;
        usageRecordId: string | null;
        ledgerEntryId: string | null;
        detail: Record<string, unknown>;
        detectedAt: string;
      }>;
    }>(`/api/commercial/reconciliation/exceptions?status=${encodeURIComponent(status)}`),
};

