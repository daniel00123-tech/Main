/** Core domain types for the INFRA control plane. */

export type CompanyStatus = "active" | "suspended" | "provisioning";

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
  createdAt: string;
  updatedAt: string;
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
  authSecretRef: string | null;
  lastHealthCheckAt: string | null;
  lastHealthyAt: string | null;
  healthMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InfraUser {
  id: string;
  email: string;
  displayName: string;
  isPlatformAdmin: boolean;
  status: UserStatus;
  memberships: Array<{
    companyId: string;
    role: CompanyRole;
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
  | "api";

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
}
