/** Core domain types for the INFRA control plane. */

export type CompanyStatus =
  | "draft"
  | "provisioning"
  | "active"
  | "suspended"
  | "closed";

export type McpEnvironmentStatus =
  | "registered"
  | "healthy"
  | "degraded"
  | "unreachable"
  | "disabled";

export type ConnectorInstanceStatus =
  | "draft"
  | "configured"
  | "syncing"
  | "healthy"
  | "degraded"
  | "error"
  | "disabled";

export type HealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

export type SyncStatus = "idle" | "running" | "completed" | "failed";

export type CredentialStatus = "pending" | "valid" | "expired" | "revoked";

export type AuditEventType =
  | "auth.login"
  | "auth.login_failed"
  | "auth.logout"
  | "auth.password_setup_completed"
  | "auth.password_setup_failed"
  | "mcp.execution_requested"
  | "mcp.execution_succeeded"
  | "mcp.execution_failed"
  | "mcp.tools_listed"
  | "connector.accessed"
  | "company.accessed"
  | "company.created"
  | "company.updated"
  | "user.created"
  | "user.disabled"
  | "role.assigned"
  | "role.changed"
  | "permission.denied"
  | "mcp.registered"
  | "mcp.updated"
  | "mcp.health_checked"
  | "connector.instance_created"
  | "connector.instance_updated"
  | "connector.changed"
  | "connector.sync_started"
  | "connector.sync_completed"
  | "connector.sync_failed"
  | "credential.created"
  | "credential.rotated"
  | "permission.updated"
  | "billing.credit_adjusted";

export type UserStatus = "active" | "disabled";

export type MembershipStatus = "active" | "disabled";

export type ServiceIdentityStatus = "active" | "disabled";

export interface Company {
  id: string;
  slug: string;
  name: string;
  status: CompanyStatus;
  primaryDomain: string | null;
  notes: string | null;
  tradingName: string | null;
  companyNumber: string | null;
  country: string | null;
  timezone: string | null;
  primaryContactName: string | null;
  primaryEmail: string | null;
  billingEmail: string | null;
  telephone: string | null;
  logoUrl: string | null;
  portalSubdomain: string | null;
  portalHostname: string | null;
  provisionedAt: string | null;
  suspendedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CompanyModule {
  id: string;
  companyId: string;
  moduleKey: string;
  status: string;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CompanyCommercialSettings {
  companyId: string;
  currency: string;
  targetGrossMarginPercent: number;
  minimumChargeCents: number;
  monthlyPlatformFeeCents: number;
  includedCreditCents: number;
  lowBalanceThresholdCents: number;
  autoTopUpEnabled: boolean;
  billingStatus: string;
  pricingPlan: string | null;
  updatedAt: string;
}

export interface CreateCompanyInput {
  legalName: string;
  tradingName?: string | null;
  /** Optional explicit slug; otherwise derived from trading/legal name */
  slug?: string | null;
  /** Short portal subdomain, e.g. caddington / ht / el */
  portalSubdomain?: string | null;
  companyNumber?: string | null;
  country?: string | null;
  timezone?: string | null;
  primaryContactName?: string | null;
  primaryEmail?: string | null;
  billingEmail?: string | null;
  telephone?: string | null;
  logoUrl?: string | null;
  primaryDomain?: string | null;
  notes?: string | null;
  /** Opening wallet credit in minor units (default 0) */
  openingCreditCents?: number;
  currency?: string;
  modules?: string[];
  adminEmail?: string | null;
  adminDisplayName?: string | null;
}

export interface McpEnvironment {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  endpointUrl: string;
  transport: "sse" | "streamable-http" | "stdio";
  status: McpEnvironmentStatus;
  enabled: boolean;
  isExternal: boolean;
  dataPlaneId: string | null;
  mcpVersion: string | null;
  businessMcpCoreVersion: string | null;
  capabilities: string[];
  /** Optional Worker secret binding name for Authorization header (never plaintext). */
  authSecretRef: string | null;
  /**
   * Optional Cloudflare service binding name for same-account Worker MCP endpoints.
   * Required when the public workers.dev URL cannot be fetched from INFRA (error 1042).
   */
  serviceBindingRef: string | null;
  lastHealthCheckAt: string | null;
  lastHealthyAt: string | null;
  healthMessage: string | null;
  lastSuccessfulRequestAt: string | null;
  lastError: string | null;
  lastLatencyMs: number | null;
  knowledgeDocumentCount: number | null;
  knowledgeChunkCount: number | null;
  lastSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InfraUser {
  id: string;
  email: string;
  displayName: string;
  isPlatformAdmin: boolean;
  status: UserStatus;
  lastLoginAt?: string | null;
  memberships: Array<{
    companyId: string;
    role: CompanyRole;
    status?: MembershipStatus;
  }>;
}

export interface CompanyMembership {
  id: string;
  userId: string;
  companyId: string;
  role: CompanyRole;
  status: MembershipStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceIdentity {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  status: ServiceIdentityStatus;
  secretRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorDefinition {
  id: string;
  slug: string;
  name: string;
  category: ConnectorCategory;
  /** Business systems ingest data; AI/channels are user interaction surfaces. */
  integrationType: ConnectorIntegrationType;
  /** Marketplace display status — independent of per-company instance state. */
  catalogueStatus: ConnectorCatalogueStatus;
  description: string;
  capabilities: ConnectorCapability[];
  credentialSchema: Record<string, unknown>;
  configSchema: Record<string, unknown>;
  supportedSyncModes: SyncMode[];
  isAvailable: boolean;
}

export interface ConnectorInstance {
  id: string;
  companyId: string;
  connectorDefinitionId: string;
  name: string;
  status: ConnectorInstanceStatus;
  config: Record<string, unknown>;
  syncSettings: ConnectorSyncSettings;
  dataEnvironmentId: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: SyncStatus | null;
  lastSyncMessage: string | null;
  healthStatus: HealthStatus;
  healthMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorSyncSettings {
  enabled: boolean;
  mode: SyncMode;
  schedule: string | null;
}

export interface CredentialRef {
  id: string;
  companyId: string;
  connectorInstanceId: string | null;
  label: string;
  provider: string;
  secretRef: string;
  status: CredentialStatus;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PermissionGrant {
  id: string;
  companyId: string;
  subjectType: "user" | "service" | "ai_client";
  subjectId: string;
  resourceType: "mcp" | "connector" | "knowledge" | "tool";
  resourceId: string;
  actions: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreditBalance {
  companyId: string;
  balanceCents: number;
  currency: string;
  updatedAt: string;
}

export interface UsageRecord {
  id: string;
  companyId: string;
  resourceType: string;
  resourceId: string | null;
  quantity: number;
  unit: string;
  recordedAt: string;
  metadata: Record<string, unknown>;
  userId?: string | null;
  actorEmail?: string | null;
  mcpEnvironmentId?: string | null;
  connectorInstanceId?: string | null;
  toolName?: string | null;
  action?: string | null;
  riskClass?: string | null;
  success?: boolean;
  durationMs?: number | null;
  sourceClient?: string | null;
  correlationId?: string | null;
  requestId?: string | null;
  underlyingCostCents?: number | null;
  customerChargeCents?: number | null;
  costBasis?: "actual" | "estimated" | "unknown" | string | null;
  underlyingCostMicros?: number | null;
  estimatedCostMicros?: number | null;
  pricingRuleId?: string | null;
  rateCardId?: string | null;
  rateCardVersion?: string | null;
  targetMarginBps?: number | null;
  calculatedSellingCents?: number | null;
  minimumChargeApplied?: boolean;
  grossProfitCents?: number | null;
  actualMarginBps?: number | null;
  ledgerEntryId?: string | null;
  settlementStatus?: string | null;
  interactionId?: string | null;
  parentRequestId?: string | null;
  mcpSessionId?: string | null;
}

export interface UsageSummary {
  requestsToday: number;
  requestsThisMonth: number;
  successfulThisMonth: number;
  failedThisMonth: number;
}

/** Customer-facing rollup of one or more usage operations that share interaction_id. */
export interface UsageInteraction {
  id: string;
  companyId: string;
  actorType: string;
  actorId: string | null;
  actorLabel: string | null;
  clientKind: string;
  mcpId: string | null;
  mcpSessionId: string | null;
  label: string;
  status: "completed" | "error" | "denied";
  currency: string;
  operationCount: number;
  customerChargeCents: number;
  providerCostCents: number | null;
  providerCostKnown: boolean;
  createdAt: string;
  updatedAt: string;
  operations: UsageRecord[];
}

export interface AuditEvent {
  id: string;
  companyId: string | null;
  eventType: AuditEventType;
  actor: string;
  resourceType: string | null;
  resourceId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface SyncHistoryEntry {
  id: string;
  connectorInstanceId: string;
  companyId: string;
  status: SyncStatus;
  startedAt: string;
  completedAt: string | null;
  itemsProcessed: number;
  itemsFailed: number;
  message: string | null;
}

export type ConnectorCategory =
  | "cloud_storage"
  | "email"
  | "field_service"
  | "accounting"
  | "helpdesk"
  | "ai_assistant"
  | "messaging"
  | "api";

export type ConnectorIntegrationType = "business_system" | "ai_channel";

export type ConnectorCatalogueStatus =
  | "active"
  | "available"
  | "coming_soon"
  | "draft";

export type ConnectorCapability =
  | "read"
  | "search"
  | "analyse"
  | "create"
  | "update"
  | "delete"
  | "send"
  | "batch"
  | "webhook"
  | "sync"
  | "index"
  | "export"
  | "live_query";

export type CapabilityRiskClass =
  | "low_risk"
  | "write"
  | "delete"
  | "batch_write"
  | "external_send"
  | "financial_action"
  | "high_risk";

export interface CapabilityDefinition {
  capability: ConnectorCapability;
  riskClass: CapabilityRiskClass;
}

export type PlatformRole =
  | "standard_user"
  | "supervisor"
  | "administrator"
  | "site_administrator"
  | "platform_owner";

/** Field-service company roles (preset permission bundles). */
export type CompanyRole =
  | "engineer"
  | "junior_office"
  | "office_staff"
  | "supervisor"
  | "manager"
  | "director"
  | "company_admin";

export type SyncMode =
  | "manual"
  | "scheduled"
  | "webhook"
  | "incremental"
  | "live_api";

export interface CompanyOverview {
  company: Company;
  mcpEnvironments: McpEnvironment[];
  connectorInstances: ConnectorInstance[];
  creditBalance: CreditBalance | null;
  recentAuditEvents: AuditEvent[];
  usageSummary?: UsageSummary;
  wallet?: {
    companyId: string;
    balanceCents: number;
    currency: string;
    lowBalanceThresholdCents: number;
    lowBalance: boolean;
    stripeCustomerId: string | null;
    updatedAt: string;
  };
  knowledgeStatus?: "configured" | "not_configured";
  warehouseStatus?: "configured" | "not_configured";
  lastUsageAt?: string | null;
  lastActivityAt?: string | null;
  aiIdentityCount?: number;
  activeAiIdentityCount?: number;
}
