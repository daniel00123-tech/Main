import { API_BASE, infraMcpGatewayUrl } from "./config";
import type {
  ActionPlanRecord,
  AuditEvent,
  AutomationDefinitionRecord,
  AutomationRunRecord,
  AutomationRunStepRecord,
  Company,
  CompanyOverview,
  CompanyRole,
  ConnectorDefinition,
  ConnectorInstance,
  CreateCompanyInput,
  InfraUser,
  McpEnvironment,
  ToolAction,
  UsageInteraction,
  UsageRecord,
  UsageSummary,
} from "@infra/shared";

export { API_BASE } from "./config";

/** ChatGPT / Claude connect here — never to a company MCP. */
export function infraMcpUrl(): string {
  return infraMcpGatewayUrl();
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
  onboardingCompanies?: number;
  suspendedCompanies?: number;
  mcpEnvironments: number;
  healthyMcp: number;
  connectorInstances: number;
  activeConnectors: number;
  recentAuditEvents: AuditEvent[];
  recentUsage?: UsageRecord[];
  permissionDenialsLast24h?: number;
  unhealthyMcp?: number;
  usageToday?: number;
  usageThisMonth?: number;
  totalWalletCents?: number;
  lowBalanceCompanies?: number;
  activeAiIdentities?: number;
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
  interactions?: UsageInteraction[];
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

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;
let authStateGetter: () => boolean = () => false;

/** Central 401 handler — wired from AuthProvider. */
export function configureApiAuth(options: {
  onUnauthorized: UnauthorizedHandler | null;
  isAuthenticated: () => boolean;
}) {
  unauthorizedHandler = options.onUnauthorized;
  authStateGetter = options.isAuthenticated;
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
    if (
      response.status === 401 &&
      unauthorizedHandler &&
      authStateGetter() &&
      !path.startsWith("/api/auth/login")
    ) {
      unauthorizedHandler();
    }
    throw new ApiError(message, response.status);
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
  requestPasswordReset: (email: string) =>
    fetchJson<{ ok: boolean; message: string; resetUrl?: string; expiresAt?: string }>(
      "/api/auth/password-reset/request",
      { method: "POST", body: JSON.stringify({ email }) },
    ),
  getSummary: () => fetchJson<PlatformSummary>("/api/summary"),
  getPlatformAttention: () =>
    fetchJson<{
      items: Array<{
        id: string;
        severity: "critical" | "warning" | "info";
        category: string;
        companyId: string | null;
        companyName: string | null;
        companySlug: string | null;
        title: string;
        detail: string;
        href: string | null;
      }>;
      checkedAt: string;
    }>("/api/platform/attention"),
  getPlatformOperationsHealth: () =>
    fetchJson<{
      checkedAt: string;
      overallState: string;
      overallSeverity: string;
      subsystems: Array<{
        id: string;
        label: string;
        state: string;
        severity: string;
        summary: string;
        detail?: string | null;
        lastCheckedAt: string;
        metrics?: Record<string, number | string | boolean | null>;
      }>;
      incidents: Array<{
        id: string;
        severity: string;
        companyId: string | null;
        companyName: string | null;
        subsystem: string;
        category: string;
        title: string;
        summary: string;
        occurrenceCount: number;
        firstObservedAt: string;
        lastObservedAt: string;
        recommendedAction: string;
        resolved: boolean;
        href: string | null;
      }>;
      companySummaries: Array<{
        companyId: string;
        companyName: string;
        companySlug: string;
        overallState: string;
        connectorIssues: number;
        billingIssues: number;
        automationFailures: number;
        knowledgeSyncIssues: number;
        authSecuritySignals: number;
        lastSuccessfulActivityAt: string | null;
        attentionCount: number;
      }>;
      schedulerHeartbeats: Array<{
        key: string;
        label: string;
        lastRunAt: string | null;
        lastSuccessAt: string | null;
        lastError: string | null;
        state: string;
      }>;
      automationProcessingMode: "queue" | "http_fallback";
      openFinancialExceptions: number;
      permissionDenialsLast24h: number;
      usageAnomalyFlags: string[];
    }>("/api/platform/operations/health"),
  runBillingReconciliationDiagnostic: () =>
    fetchJson<{
      checkedAt: string;
      openExceptions: number;
      healedLinks: number;
      createdExceptions: number;
      anomalies: string[];
    }>("/api/platform/operations/billing-reconciliation", { method: "POST" }),
  getCompanyAttention: (slug: string) =>
    fetchJson<{
      items: Array<{
        id: string;
        severity: "critical" | "warning" | "info";
        title: string;
        detail: string;
        href: string | null;
      }>;
      checkedAt: string;
    }>(`/api/companies/${encodeURIComponent(slug)}/attention`),
  getCompaniesAdminDirectory: () =>
    fetchJson<
      Array<{
        id: string;
        name: string;
        slug: string;
        status: string;
        primaryDomain: string | null;
        walletBalanceCents: number;
        walletLowBalance: boolean;
        usageThisMonth: number;
        usageFailedThisMonth: number;
        spendThisMonthCents: number;
        lastActivityAt: string | null;
        connectorCount: number;
        connectedConnectors: number;
        mcpStatus: string | null;
        aiIdentityCount: number;
        activeUserCount: number;
        needsAttention: boolean;
      }>
    >("/api/companies/admin-directory"),
  dismissAttention: (input: {
    attentionKey: string;
    severity: "critical" | "warning" | "info";
    snoozeUntil?: string | null;
  }) =>
    fetchJson<{ ok: boolean }>("/api/platform/attention/dismiss", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  exportCommercialUsage: (params?: {
    companyId?: string;
    sourceClient?: string;
    success?: boolean;
    from?: string;
    to?: string;
  }) => {
    const q = new URLSearchParams();
    if (params?.companyId) q.set("companyId", params.companyId);
    if (params?.sourceClient) q.set("sourceClient", params.sourceClient);
    if (params?.success === true) q.set("success", "true");
    if (params?.success === false) q.set("success", "false");
    if (params?.from) q.set("from", params.from);
    if (params?.to) q.set("to", params.to);
    const suffix = q.toString() ? `?${q}` : "";
    return fetch(`${API_BASE}/api/commercial/usage/export${suffix}`, {
      credentials: "include",
    }).then(async (response) => {
      if (!response.ok) {
        let message = `Export failed: ${response.status}`;
        try {
          const body = (await response.json()) as { error?: string };
          if (body.error) message = body.error;
        } catch {
          /* ignore */
        }
        throw new Error(message);
      }
      return response.blob();
    });
  },
  getCompanies: (params?: { q?: string; status?: string; limit?: number; offset?: number }) => {
    const search = new URLSearchParams();
    if (params?.q) search.set("q", params.q);
    if (params?.status) search.set("status", params.status);
    if (params?.limit) search.set("limit", String(params.limit));
    if (params?.offset) search.set("offset", String(params.offset));
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return fetchJson<Company[]>(`/api/companies${suffix}`);
  },
  checkCompanySlug: (slug: string) =>
    fetchJson<{ available: boolean; slug: string; error: string | null }>(
      `/api/companies/slug-availability?slug=${encodeURIComponent(slug)}`,
    ),
  registerExistingMcp: (input: {
    companySlug: string;
    name: string;
    endpointUrl: string;
    authSecretRef: string;
    serviceBindingRef?: string;
    description?: string;
  }) =>
    fetchJson<McpEnvironment>("/api/mcp-environments", {
      method: "POST",
      body: JSON.stringify(input),
    }),
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
  setCompanyStatus: (
    slug: string,
    status: "onboarding" | "active" | "suspended" | "archived" | "closed",
    reason?: string,
  ) =>
    fetchJson<Company>(`/api/companies/${slug}/status`, {
      method: "POST",
      body: JSON.stringify({ status, ...(reason ? { reason } : {}) }),
    }),
  deleteCompany: (slug: string) =>
    fetchJson<{ ok: boolean }>(`/api/companies/${slug}`, { method: "DELETE" }),
  getCompany: (slug: string) => fetchJson<Company>(`/api/companies/${slug}`),
  getCompanyOverview: (slug: string) =>
    fetchJson<CompanyOverview>(`/api/companies/${slug}/overview`),
  listCompanyActions: (slug: string, status?: string) => {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    return fetchJson<{ plans: ActionPlanRecord[] }>(`/api/companies/${slug}/actions${query}`);
  },
  getCompanyAction: (slug: string, planId: string) =>
    fetchJson<{ plan: ActionPlanRecord; execution?: unknown }>(
      `/api/companies/${slug}/actions/${planId}`,
    ),
  getCompanyActionDryRun: (slug: string, planId: string) =>
    fetchJson<{ report: Record<string, unknown> }>(
      `/api/companies/${slug}/actions/${planId}/dry-run`,
    ),
  getCompanyActionExecution: (slug: string, planId: string) =>
    fetchJson<{ execution: unknown }>(`/api/companies/${slug}/actions/${planId}/execution`),
  confirmCompanyAction: (slug: string, planId: string, confirmationToken?: string) =>
    fetchJson<{ plan: ActionPlanRecord }>(`/api/companies/${slug}/actions/${planId}/confirm`, {
      method: "POST",
      body: JSON.stringify({ confirmationToken }),
    }),
  approveCompanyAction: (slug: string, planId: string) =>
    fetchJson<{ plan: ActionPlanRecord; execution?: unknown }>(
      `/api/companies/${slug}/actions/${planId}/approve`,
      { method: "POST" },
    ),
  rejectCompanyAction: (slug: string, planId: string, reason?: string) =>
    fetchJson<{ plan: ActionPlanRecord }>(`/api/companies/${slug}/actions/${planId}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  cancelCompanyAction: (slug: string, planId: string) =>
    fetchJson<{ plan: ActionPlanRecord }>(`/api/companies/${slug}/actions/${planId}/cancel`, {
      method: "POST",
    }),
  listAutomationTemplates: () =>
    fetchJson<{
      templates: Array<{
        key: string;
        type: string;
        label: string;
        description: string;
        system: string;
        defaultName: string;
        defaultSchedule: { frequency: string; hour?: number; minute?: number };
        defaultTimezone: string;
        available: boolean;
      }>;
    }>("/api/automation-templates"),
  listCompanyAutomations: (slug: string) =>
    fetchJson<{
      automations: Array<
        AutomationDefinitionRecord & {
          templateKey?: string | null;
          templateLabel?: string | null;
          recipientEmail?: string | null;
          scheduleLabel?: string | null;
          createdVia?: import("@infra/shared").AutomationCreatedVia | null;
          archived?: boolean;
        }
      >;
    }>(`/api/companies/${slug}/automations`),
  createCompanyAutomationFromTemplate: (
    slug: string,
    input: {
      templateKey: string;
      name?: string;
      recipientEmail?: string;
      timezone?: string;
      hour?: number;
      minute?: number;
      frequency?: "hourly" | "daily" | "weekdays" | "weekly" | "monthly";
      activate?: boolean;
      allowDuplicate?: boolean;
    },
  ) =>
    fetchJson<{ automation: AutomationDefinitionRecord }>(
      `/api/companies/${slug}/automations/from-template`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  getCompanyAutomation: (slug: string, automationId: string) =>
    fetchJson<{ automation: AutomationDefinitionRecord & { scheduleLabel?: string | null } }>(
      `/api/companies/${slug}/automations/${automationId}`,
    ),
  createCompanyAutomation: (
    slug: string,
    input: {
      name: string;
      description?: string;
      triggerType?: "manual" | "schedule";
      schedule?: { frequency: string; hour?: number; minute?: number; dayOfWeek?: number; dayOfMonth?: number };
      timezone?: string;
      actionType?: "ai_prompt" | "mcp_tool" | "internal";
      configuration?: Record<string, unknown>;
    },
  ) =>
    fetchJson<{ automation: AutomationDefinitionRecord }>(`/api/companies/${slug}/automations`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateCompanyAutomation: (
    slug: string,
    automationId: string,
    input: Record<string, unknown>,
  ) =>
    fetchJson<{ automation: AutomationDefinitionRecord }>(
      `/api/companies/${slug}/automations/${automationId}`,
      { method: "PATCH", body: JSON.stringify(input) },
    ),
  activateCompanyAutomation: (slug: string, automationId: string) =>
    fetchJson<{ automation: AutomationDefinitionRecord }>(
      `/api/companies/${slug}/automations/${automationId}/activate`,
      { method: "POST" },
    ),
  pauseCompanyAutomation: (slug: string, automationId: string) =>
    fetchJson<{ automation: AutomationDefinitionRecord }>(
      `/api/companies/${slug}/automations/${automationId}/pause`,
      { method: "POST" },
    ),
  disableCompanyAutomation: (slug: string, automationId: string) =>
    fetchJson<{ automation: AutomationDefinitionRecord }>(
      `/api/companies/${slug}/automations/${automationId}/disable`,
      { method: "POST" },
    ),
  archiveCompanyAutomation: (slug: string, automationId: string) =>
    fetchJson<{ automation: AutomationDefinitionRecord }>(
      `/api/companies/${slug}/automations/${automationId}/archive`,
      { method: "POST" },
    ),
  runCompanyAutomation: (
    slug: string,
    automationId: string,
    options?: { idempotencyKey?: string },
  ) =>
    fetchJson<{
      success: boolean;
      automationId: string;
      automationName: string;
      runId: string;
      status: string;
      trigger: string;
      scheduledFor: null;
      scheduleChanged: false;
      reusedExisting?: boolean;
      created: boolean;
      run: AutomationRunRecord;
    }>(`/api/companies/${slug}/automations/${automationId}/run`, {
      method: "POST",
      headers: options?.idempotencyKey
        ? { "Idempotency-Key": options.idempotencyKey }
        : undefined,
    }),
  listCompanyAutomationRuns: (slug: string, automationId: string) =>
    fetchJson<{ runs: AutomationRunRecord[] }>(
      `/api/companies/${slug}/automations/${automationId}/runs`,
    ),
  getCompanyAutomationRun: (slug: string, runId: string) =>
    fetchJson<{ run: AutomationRunRecord; steps: AutomationRunStepRecord[] }>(
      `/api/companies/${slug}/automation-runs/${runId}`,
    ),
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
  getAuditEvents: (params?: {
    companyId?: string;
    limit?: number;
    category?: string;
    from?: string;
    to?: string;
    actor?: string;
  }) => {
    const search = new URLSearchParams({
      limit: String(params?.limit ?? 100),
    });
    if (params?.companyId) search.set("companyId", params.companyId);
    if (params?.category) search.set("category", params.category);
    if (params?.from) search.set("from", params.from);
    if (params?.to) search.set("to", params.to);
    if (params?.actor) search.set("actor", params.actor);
    return fetchJson<AuditEvent[]>(`/api/audit-events?${search.toString()}`);
  },
  getUsers: (companyId?: string) => {
    const query = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
    return fetchJson<InfraUser[]>(`/api/users${query}`);
  },
  getRolePresets: (companySlug?: string) =>
    fetchJson<RolePresetResponse[]>(
      `/api/roles/presets${companySlug ? `?company=${encodeURIComponent(companySlug)}` : ""}`,
    ),
  getElvexRbac: (slug: string) =>
    fetchJson<{
      companyId: string;
      companySlug: string;
      identityLimitation: string;
      roles: Array<{
        role: string;
        label: string;
        capabilities: Array<{ capability: string; access: "read" | "write" }>;
      }>;
      classifications: Array<{ id: string; label: string }>;
      protectedMicrosoftUsers: Array<{ hint: string; label: string }>;
      canManageRoles: boolean;
    }>(`/api/companies/${encodeURIComponent(slug)}/elvex-rbac`),
  getCompanyRolePermissions: (slug: string) =>
    fetchJson<{
      companyId: string;
      companySlug: string;
      overrides: Array<{ role: CompanyRole; action: string; effect: "allow" | "deny" }>;
      editableRoles: CompanyRole[];
      presets: RolePresetResponse[];
      canEdit?: boolean;
    }>(`/api/companies/${encodeURIComponent(slug)}/role-permissions`),
  saveCompanyRolePermissions: (
    slug: string,
    input: { role: CompanyRole; grants: Array<{ action: string; effect: "allow" | "deny" }> },
  ) =>
    fetchJson<{ ok: boolean; overrides: Array<{ role: CompanyRole; action: string; effect: "allow" | "deny" }> }>(
      `/api/companies/${encodeURIComponent(slug)}/role-permissions`,
      { method: "PUT", body: JSON.stringify(input) },
    ),
  runMcpHealthCheck: (id: string) =>
    fetchJson<Record<string, unknown>>(`/api/mcp-environments/${id}/health-check`, {
      method: "POST",
    }),
  refreshMcpCapabilities: (id: string) =>
    fetchJson<Record<string, unknown>>(
      `/api/mcp-environments/${id}/refresh-capabilities`,
      { method: "POST" },
    ),
  getCredentialStorage: () =>
    fetchJson<{
      enabled: boolean;
      reason: string;
      xero?: {
        appConfigured: boolean;
        storageEnabled: boolean;
        readyToConnect: boolean;
        scopes: string[];
      };
    }>("/api/credential-storage"),
  getConnectorProductisation: (slug: string) =>
    fetchJson<import("@infra/shared").CompanyConnectorProductisationReport>(
      `/api/companies/${slug}/connectors/productisation`,
    ),
  getConnectorWizard: (slug: string, definitionId: string) =>
    fetchJson<{ wizard: import("@infra/shared").ConnectorWizardState; definition: import("@infra/shared").ConnectorDefinition }>(
      `/api/companies/${slug}/connectors/${definitionId}/wizard`,
    ),
  getConnectorCredentialMetadata: (slug: string, instanceId: string) =>
    fetchJson<{
      stored: boolean;
      credentialRefId: string | null;
      status: string | null;
      lastUpdated: string | null;
      fields: Array<{ name: string; masked: true }>;
      storage: { enabled: boolean; reason: string };
      xero?: {
        organisationName: string | null;
        organisationSelected: boolean;
        pendingOrganisations: Array<{ tenantId: string; name: string }>;
        authStatus: string | null;
        connectedAt: string | null;
        lastCheckedAt: string | null;
        grantedScopes: string[];
      };
    }>(`/api/companies/${slug}/connectors/${instanceId}/credentials`),
  startConnectorOAuth: (slug: string, definitionId: string) =>
    fetchJson<{
      authorizationUrl: string;
      expiresAt: string;
      instanceId: string;
    }>(`/api/companies/${slug}/connectors/${definitionId}/oauth/start`, {
      method: "POST",
      body: "{}",
    }),
  startMicrosoftOAuth: (
    slug: string,
    body: {
      definitionId?: string;
      instanceId?: string;
      component?: string;
      authMode?: "platform_multitenant" | "company_app";
    },
  ) =>
    fetchJson<{ authorizationUrl: string; state: string; instanceId?: string }>(
      `/api/companies/${slug}/connectors/microsoft/oauth/start`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  listXeroTestArtefacts: (slug: string, prefix?: string) =>
    fetchJson<{
      reportOnly: boolean;
      prefix: string;
      artefacts: Array<{
        type: string;
        invoiceNumber: string | null;
        reference: string | null;
        xeroId: string;
        amount: number | null;
        status: string | null;
        recommendedCleanup?: string;
      }>;
      note: string;
      instanceId?: string;
    }>(`/api/companies/${slug}/xero/test-artefacts${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ""}`),
  getMicrosoftHealth: () =>
    fetchJson<{
      credentials: {
        configured: boolean;
        authMode: string;
        tenantIdMasked: string | null;
      };
      graph: { ok: boolean; message: string } | null;
      knowledgeBridgeConfigured: boolean;
    }>("/api/connectors/microsoft/health"),
  getMicrosoftDashboard: (slug: string) =>
    fetchJson<{
      status: Record<string, unknown>;
      instanceId: string | null;
      health: Awaited<ReturnType<typeof api.getMicrosoftHealth>> & {
        authMode?: string | null;
        tenantIdMasked?: string | null;
        connected?: boolean;
      };
      summary: {
        onedrive: { total: number; included: number; indexed: number };
        sharepoint: { total: number; included: number; indexed: number };
        outlook: { total: number; status: string };
      };
      sources: Array<{
        id: string;
        sourceType: string;
        displayName: string;
        inclusionStatus: string;
        syncStatus: string;
        itemsIndexed: number;
        itemsDiscovered: number;
        ownerUpn: string | null;
        ownerDisplayName: string | null;
        pathOrUrl: string | null;
        lastSyncAt: string | null;
        lastError: string | null;
        folderScopeMode?: string;
        folderIncludePaths?: string[];
        folderExcludePaths?: string[];
        queueStats?: {
          pending: number;
          byStatus: Record<string, number>;
          latestFailure: { fileName: string; error: string; at: string } | null;
        };
      }>;
    }>(`/api/companies/${slug}/microsoft/dashboard`),
  discoverMicrosoftSources: (
    slug: string,
    body?: { includeAllOneDrives?: boolean; includeAllSharePoint?: boolean; instanceId?: string },
  ) =>
    fetchJson<{ ok: boolean; discovered: number; onedrive: number; sharepoint: number; instanceId: string }>(
      `/api/companies/${slug}/microsoft/discover`,
      { method: "POST", body: JSON.stringify(body ?? {}) },
    ),
  setMicrosoftSourceInclusion: (
    slug: string,
    sourceId: string,
    inclusionStatus: "included" | "excluded" | "available",
  ) =>
    fetchJson<{ ok: boolean }>(`/api/companies/${slug}/microsoft/sources/${sourceId}/inclusion`, {
      method: "PATCH",
      body: JSON.stringify({ inclusionStatus }),
    }),
  setMicrosoftSourceFolderScope: (
    slug: string,
    sourceId: string,
    body: {
      mode: "all" | "include_paths" | "exclude_paths";
      includePaths?: string[];
      excludePaths?: string[];
    },
  ) =>
    fetchJson<{ ok: boolean }>(`/api/companies/${slug}/microsoft/sources/${sourceId}/folder-scope`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  syncMicrosoftSource: (slug: string, sourceId: string, body?: { useDelta?: boolean; maxFiles?: number }) =>
    fetchJson<{
      ok: boolean;
      discovered: number;
      queued: number;
      indexed: number;
      skipped: number;
      unsupported: number;
      failed: number;
      deleted: number;
      syncRunId: string;
      mode: "queue" | "inline";
    }>(
      `/api/companies/${slug}/microsoft/sources/${sourceId}/sync`,
      { method: "POST", body: JSON.stringify(body ?? {}) },
    ),
  selectXeroOrganisation: (slug: string, instanceId: string, tenantId: string) =>
    fetchJson<{ ok: boolean; organisationName: string }>(
      `/api/companies/${slug}/connectors/${instanceId}/xero/select-organisation`,
      { method: "POST", body: JSON.stringify({ tenantId }) },
    ),
  startXeroScopeUpgrade: (slug: string, instanceId: string) =>
    fetchJson<{
      authorizationUrl: string;
      expiresAt: string;
      instanceId: string;
      requestedScopes: string[];
    }>(`/api/companies/${slug}/connectors/${instanceId}/xero/scope-upgrade`, {
      method: "POST",
      body: "{}",
    }),
  saveConnectorCredentials: (
    slug: string,
    instanceId: string,
    body: {
      credentials?: Record<string, string>;
      config?: Record<string, string>;
      label?: string;
    },
  ) =>
    fetchJson<{
      ok: boolean;
      credentialRefId: string;
      stored: boolean;
      tested: boolean;
      authStatus: string;
    }>(`/api/companies/${slug}/connectors/${instanceId}/credentials`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  rotateConnectorCredentials: (
    slug: string,
    instanceId: string,
    body: {
      credentials?: Record<string, string>;
      config?: Record<string, string>;
      credentialRefId?: string;
    },
  ) =>
    fetchJson<{ ok: boolean }>(
      `/api/companies/${slug}/connectors/${instanceId}/rotate`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  testConnectorConnection: (slug: string, instanceId: string) =>
    fetchJson<{ tested: boolean; code?: string; message?: string }>(
      `/api/companies/${slug}/connectors/${instanceId}/test`,
      { method: "POST", body: "{}" },
    ),
  disconnectConnector: (slug: string, instanceId: string) =>
    fetchJson<{ ok: boolean; authStatus: string }>(
      `/api/companies/${slug}/connectors/${instanceId}/disconnect`,
      { method: "POST", body: "{}" },
    ),
  setupConnector: (
    slug: string,
    definitionId: string,
    body?: { name?: string; config?: Record<string, unknown> },
  ) =>
    fetchJson<{
      id: string;
      companyId: string;
      connectorDefinitionId: string;
      status: string;
      authStatus: string;
      credentialSubmission: string;
      credentialRefId: string | null;
    }>(`/api/companies/${slug}/connectors/${definitionId}/setup`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),
  getConnectorOversight: () =>
    fetchJson<
      Array<{
        companyId: string;
        companyName: string;
        companySlug: string;
        companyStatus: string;
        connectorInstanceId: string;
        connectorDefinitionId: string;
        name: string;
        status: string;
        authStatus: string;
        syncHealth: string;
        providerHealth: string;
        lastSyncAt: string | null;
        lastSuccessfulSyncAt: string | null;
        lastErrorCode: string | null;
        lastErrorMessage: string | null;
        managedBy: string | null;
      }>
    >("/api/admin/connectors"),
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
        testCreditCents?: number;
        paidCreditCents?: number;
        spendThisMonthCents?: number;
        walletHealthState?: "healthy" | "low" | "critical" | "empty";
      };
      billing?: {
        spendThisMonthCents: number;
        monthStartUtc: string;
        lowBalanceThresholdCents: number;
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
        metadata?: Record<string, unknown>;
      }>;
      chargeGroups?: Array<{
        id: string;
        kind: "interaction" | "entry";
        label: string;
        amountCents: number;
        createdAt: string;
        entries: Array<{
          id: string;
          description: string | null;
          amountCents: number;
          createdAt: string;
        }>;
      }>;
      stripeConfigured: boolean;
      topUpOptionsCents: number[];
      paymentProvider?: {
        provider: string;
        configured: boolean;
        status: string;
        message: string;
        stripeMode?: string;
        testModeOnly?: boolean;
        companyBillingMode?: "test" | "live";
        topUpCheckoutAllowed?: boolean;
        topUpBlockedReason?: string | null;
        topUpOptionsCents: number[];
        autoTopUp: {
          supported: boolean;
          enabled: boolean;
          thresholdCents: number | null;
          amountCents: number | null;
          paymentMethodReady?: boolean;
          setupRequired?: boolean;
          message?: string;
        };
      };
      recentTopUps?: Array<{
        id: string;
        amountCents: number;
        currency: string;
        status: string;
        createdAt: string;
        creditedAt?: string | null;
        failureReason?: string | null;
      }>;
    }>(`/api/companies/${slug}/wallet`),
  getTopUpStatus: (slug: string, checkoutId: string) =>
    fetchJson<{
      checkout: {
        id: string;
        status: string;
        amountCents: number;
        currency: string;
        ledgerCredited: boolean;
        awaitingWebhook: boolean;
        creditedAt?: string | null;
      };
    }>(`/api/companies/${slug}/wallet/top-up/${checkoutId}`),
  getBillingOverview: () =>
    fetchJson<{
      paymentProvider: { provider: string; configured: boolean; message: string };
      tide: { role: string; integrated: boolean; note: string };
      totalWalletCents: number;
      companyCount: number;
      lowBalanceCompanies: Array<{ companyName: string; companySlug: string; balanceCents: number }>;
      balances: Array<{
        companyId: string;
        companyName: string;
        companySlug: string;
        balanceCents: number;
        currency: string;
        lowBalance: boolean;
      }>;
    }>("/api/billing/overview"),
  createTopUp: (slug: string, amountCents: number) =>
    fetchJson<Record<string, unknown>>(`/api/companies/${slug}/wallet/top-up`, {
      method: "POST",
      body: JSON.stringify({ amountCents }),
    }),
  getPaymentMethod: (slug: string) =>
    fetchJson<{
      paymentMethod: {
        configured: boolean;
        hasPaymentMethod: boolean;
        brand: string | null;
        last4: string | null;
        expMonth: number | null;
        expYear: number | null;
        setupRequired: boolean;
        message: string;
      };
    }>(`/api/companies/${slug}/wallet/payment-method`),
  startPaymentMethodSetup: (slug: string) =>
    fetchJson<{ url: string; stripeConfigured: boolean; testMode: boolean }>(
      `/api/companies/${slug}/wallet/payment-method/setup`,
      { method: "POST", body: "{}" },
    ),
  updateAutoTopUp: (
    slug: string,
    input: { enabled: boolean; thresholdCents: number; amountCents: number; confirm?: boolean },
  ) =>
    fetchJson<{ settings: Record<string, unknown> }>(`/api/companies/${slug}/wallet/auto-topup`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  getCompanySettings: (slug: string) =>
    fetchJson<{ settings: Record<string, unknown> }>(`/api/companies/${slug}/settings`),
  updateCompanySettings: (slug: string, patch: Record<string, unknown>) =>
    fetchJson<{ settings: Record<string, unknown> }>(`/api/companies/${slug}/settings`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  removePaymentMethod: (slug: string, disableAutoTopUp?: boolean) =>
    fetchJson<{ ok: boolean }>(`/api/companies/${slug}/wallet/payment-method`, {
      method: "DELETE",
      body: JSON.stringify({ disableAutoTopUp }),
    }),
  getNotifications: (slug: string) =>
    fetchJson<{
      notifications: Array<{
        id: string;
        title: string;
        body: string;
        severity: string;
        href: string | null;
        readAt: string | null;
        createdAt: string;
      }>;
      unreadCount: number;
    }>(`/api/companies/${slug}/notifications`),
  markNotificationRead: (slug: string, id: string) =>
    fetchJson<{ ok: boolean }>(`/api/companies/${slug}/notifications/${id}/read`, {
      method: "POST",
      body: "{}",
    }),
  markAllNotificationsRead: (slug: string) =>
    fetchJson<{ ok: boolean }>(`/api/companies/${slug}/notifications/read-all`, {
      method: "POST",
      body: "{}",
    }),
  getBillingDocuments: (slug: string) =>
    fetchJson<{ documents: Array<Record<string, unknown>> }>(
      `/api/companies/${slug}/billing-documents`,
    ),
  getAddonCatalog: () => fetchJson<{ addons: Array<Record<string, unknown>> }>("/api/addons/catalog"),
  getCompanyAddons: (slug: string) =>
    fetchJson<{ subscriptions: Array<Record<string, unknown>> }>(`/api/companies/${slug}/addons`),
  requestAddon: (slug: string, addonSlug: string) =>
    fetchJson<{ id: string; status: string }>(`/api/companies/${slug}/addons/request`, {
      method: "POST",
      body: JSON.stringify({ addonSlug }),
    }),
  getTeams: (slug: string) =>
    fetchJson<{ teams: Array<Record<string, unknown>> }>(`/api/companies/${slug}/teams`),
  createTeam: (slug: string, input: { name: string; description?: string }) =>
    fetchJson<{ team: Record<string, unknown> }>(`/api/companies/${slug}/teams`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getInvitations: (slug: string) =>
    fetchJson<{ invitations: Array<Record<string, unknown>> }>(
      `/api/companies/${slug}/invitations`,
    ),
  cancelInvitation: (slug: string, id: string) =>
    fetchJson<{ ok: boolean }>(`/api/companies/${slug}/invitations/${id}/cancel`, {
      method: "POST",
      body: "{}",
    }),
  resendInvitation: (slug: string, id: string) =>
    fetchJson<{ setupUrl: string; emailSent: boolean; emailError?: string }>(
      `/api/companies/${slug}/invitations/${id}/resend`,
      { method: "POST", body: "{}" },
    ),
  getBillingPayments: (slug: string) =>
    fetchJson<{ payments: Array<Record<string, unknown>> }>(
      `/api/companies/${slug}/billing-payments`,
    ),
  getAutoTopUpTransactions: (slug: string) =>
    fetchJson<{ transactions: Array<Record<string, unknown>> }>(
      `/api/companies/${slug}/wallet/auto-topup/transactions`,
    ),
  getAutoTopUpDiagnostics: (slug: string) =>
    fetchJson<{ diagnostics: Record<string, unknown> }>(
      `/api/companies/${slug}/wallet/auto-topup/diagnostics`,
    ),
  getWalletHealth: (slug: string) =>
    fetchJson<{
      health: {
        state: string;
        balanceCents: number;
        thresholdCents: number;
        promotionalCents: number;
        paidCents: number;
      };
    }>(`/api/companies/${slug}/wallet/health`),
  getFailedRequests: () =>
    fetchJson<{ failures: Array<Record<string, unknown>> }>("/api/platform/failed-requests"),
  getWeeklyReview: () =>
    fetchJson<{ summary: Array<Record<string, unknown>>; generatedAt: string }>(
      "/api/platform/weekly-review",
    ),
  getCustomRoles: (slug: string) =>
    fetchJson<{ roles: Array<Record<string, unknown>> }>(`/api/companies/${slug}/custom-roles`),
  createCustomRole: (slug: string, input: { name: string; description?: string; cloneFromRole?: string }) =>
    fetchJson<{ role: Record<string, unknown> }>(`/api/companies/${slug}/custom-roles`, {
      method: "POST",
      body: JSON.stringify(input),
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
      emailSent?: boolean;
      emailError?: string;
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
  resetCompanyUserPassword: (
    slug: string,
    userId: string,
    input?: { temporaryPassword?: string },
  ) =>
    fetchJson<{
      ok: boolean;
      mode: "link" | "temporary";
      resetUrl?: string;
      setupUrl?: string;
      expiresAt: string;
      message: string;
    }>(`/api/companies/${slug}/users/${userId}/reset-password`, {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    }),
  removeCompanyUser: (slug: string, userId: string) =>
    fetchJson<{ ok: boolean }>(`/api/companies/${slug}/users/${userId}/remove`, {
      method: "POST",
      body: "{}",
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
        paidCreditCents: number;
        promotionalCreditCents: number;
        spendThisMonthCents: number;
        creditsAddedThisMonthCents: number;
      }>
    >("/api/billing/balances"),
  getBillingSummary: () =>
    fetchJson<{
      companyCount: number;
      totalWalletCents: number;
      totalPaidCreditCents: number;
      totalPromotionalCreditCents: number;
      spendThisMonthCents: number;
      creditsAddedThisMonthCents: number;
      lowBalanceCount: number;
      monthStart: string;
    }>("/api/billing/summary"),
  getBillingLedger: (params?: {
    companyId?: string;
    from?: string;
    to?: string;
    entryType?: string;
    creditClass?: "paid" | "promotional";
    q?: string;
    limit?: number;
  }) => {
    const search = new URLSearchParams();
    if (params?.companyId) search.set("companyId", params.companyId);
    if (params?.from) search.set("from", params.from);
    if (params?.to) search.set("to", params.to);
    if (params?.entryType) search.set("entryType", params.entryType);
    if (params?.creditClass) search.set("creditClass", params.creditClass);
    if (params?.q) search.set("q", params.q);
    if (params?.limit) search.set("limit", String(params.limit));
    const suffix = search.toString() ? `?${search}` : "";
    return fetchJson<
      Array<{
        id: string;
        companyId: string;
        companyName: string;
        companySlug: string;
        entryType: string;
        amountCents: number;
        currency: string;
        balanceAfterCents: number;
        description: string | null;
        referenceType: string | null;
        referenceId: string | null;
        metadata: Record<string, unknown>;
        createdBy: string | null;
        createdAt: string;
        creditClass: "paid" | "promotional" | null;
        sourceLabel: string;
      }>
    >(`/api/billing/ledger${suffix}`);
  },
  exportBillingLedgerUrl: (params?: {
    companyId?: string;
    from?: string;
    to?: string;
    entryType?: string;
    creditClass?: "paid" | "promotional";
    q?: string;
  }) => {
    const search = new URLSearchParams();
    if (params?.companyId) search.set("companyId", params.companyId);
    if (params?.from) search.set("from", params.from);
    if (params?.to) search.set("to", params.to);
    if (params?.entryType) search.set("entryType", params.entryType);
    if (params?.creditClass) search.set("creditClass", params.creditClass);
    if (params?.q) search.set("q", params.q);
    const suffix = search.toString() ? `?${search}` : "";
    return `${API_BASE}/api/billing/ledger/export${suffix}`;
  },
  grantWalletCredit: (
    slug: string,
    input: {
      amountCents: number;
      reason: string;
      creditClass?: "paid" | "promotional";
      description?: string;
      internalNote?: string;
    },
  ) =>
    fetchJson<unknown>(`/api/companies/${slug}/wallet/manual-credit`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
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
        underlyingCostsCents: number | null;
        providerCostKnown?: boolean;
        grossProfitCents: number | null;
        grossMarginBps: number | null;
      };
      records: UsageRecord[];
      interactions?: UsageInteraction[];
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
  updateProviderRateCardItems: (
    cardId: string,
    items: Array<{ id: string; unitCostMicros: number; notes?: string | null }>,
  ) =>
    fetchJson<{
      card: Record<string, unknown>;
      items: Array<{ id: string; unitCostMicros: number; notes: string | null }>;
    }>(`/api/commercial/provider-costs/${encodeURIComponent(cardId)}/items`, {
      method: "PUT",
      body: JSON.stringify({ items }),
    }),
  approveProviderRateCard: (cardId: string) =>
    fetchJson<{ ok: boolean; card: Record<string, unknown> }>(
      `/api/commercial/provider-costs/${encodeURIComponent(cardId)}/approve`,
      { method: "POST", body: "{}" },
    ),
  getPricingRules: (companyId?: string) => {
    const suffix = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
    return fetchJson<{
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
        marginBasis: string;
        costCategory: string | null;
      }>;
    }>(`/api/pricing/rules${suffix}`);
  },
  createPricingPolicy: (input: {
    companyId?: string | null;
    targetMarginBps: number;
    minimumChargeCents: number;
    label?: string;
  }) =>
    fetchJson<{ policy: Record<string, unknown> }>("/api/pricing/policies", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  previewPricing: (input: {
    companyId?: string | null;
    action: string;
    underlyingCostMicros?: number | null;
    underlyingCostCents?: number | null;
  }) =>
    fetchJson<{
      action: string;
      underlyingCostCents: number | null;
      targetMarginBps: number;
      calculatedPriceCents: number;
      minimumChargeCents: number;
      finalCustomerChargeCents: number;
      minimumApplied: boolean;
      pricingRuleId: string | null;
      pricingLabel: string | null;
    }>("/api/pricing/preview", {
      method: "POST",
      body: JSON.stringify(input),
    }),
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

