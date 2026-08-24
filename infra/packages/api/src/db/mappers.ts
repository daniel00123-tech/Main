import type {
  AuditEvent,
  Company,
  ConnectorInstance,
  ConnectorSyncSettings,
  CreditBalance,
  McpEnvironment,
  SyncHistoryEntry,
} from "@infra/shared";

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function rowToCompany(row: Record<string, unknown>): Company {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    status: row.status as Company["status"],
    primaryDomain: row.primary_domain ? String(row.primary_domain) : null,
    notes: row.notes ? String(row.notes) : null,
    tradingName: row.trading_name ? String(row.trading_name) : null,
    companyNumber: row.company_number ? String(row.company_number) : null,
    country: row.country ? String(row.country) : null,
    timezone: row.timezone ? String(row.timezone) : null,
    primaryContactName: row.primary_contact_name
      ? String(row.primary_contact_name)
      : null,
    primaryEmail: row.primary_email ? String(row.primary_email) : null,
    billingEmail: row.billing_email ? String(row.billing_email) : null,
    telephone: row.telephone ? String(row.telephone) : null,
    logoUrl: row.logo_url ? String(row.logo_url) : null,
    portalSubdomain: row.portal_subdomain ? String(row.portal_subdomain) : null,
    portalHostname: row.portal_hostname ? String(row.portal_hostname) : null,
    provisionedAt: row.provisioned_at ? String(row.provisioned_at) : null,
    suspendedAt: row.suspended_at ? String(row.suspended_at) : null,
    closedAt: row.closed_at ? String(row.closed_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function rowToMcpEnvironment(row: Record<string, unknown>): McpEnvironment {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    name: String(row.name),
    description: row.description ? String(row.description) : null,
    endpointUrl: String(row.endpoint_url),
    transport: row.transport as McpEnvironment["transport"],
    status: row.status as McpEnvironment["status"],
    enabled: row.enabled === undefined ? true : Boolean(row.enabled),
    isExternal: Boolean(row.is_external),
    dataPlaneId: row.data_plane_id ? String(row.data_plane_id) : null,
    mcpVersion: row.mcp_version ? String(row.mcp_version) : null,
    businessMcpCoreVersion: row.business_mcp_core_version
      ? String(row.business_mcp_core_version)
      : null,
    capabilities: parseJsonArray(
      row.capabilities_json ? String(row.capabilities_json) : null,
    ),
    authSecretRef: row.auth_secret_ref ? String(row.auth_secret_ref) : null,
    serviceBindingRef: row.service_binding_ref
      ? String(row.service_binding_ref)
      : null,
    lastHealthCheckAt: row.last_health_check_at
      ? String(row.last_health_check_at)
      : null,
    lastHealthyAt: row.last_healthy_at ? String(row.last_healthy_at) : null,
    healthMessage: row.health_message ? String(row.health_message) : null,
    lastSuccessfulRequestAt: row.last_successful_request_at
      ? String(row.last_successful_request_at)
      : null,
    lastError: row.last_error ? String(row.last_error) : null,
    lastLatencyMs:
      row.last_latency_ms == null ? null : Number(row.last_latency_ms),
    knowledgeDocumentCount:
      row.knowledge_document_count == null
        ? null
        : Number(row.knowledge_document_count),
    knowledgeChunkCount:
      row.knowledge_chunk_count == null
        ? null
        : Number(row.knowledge_chunk_count),
    lastSyncAt: row.last_sync_at ? String(row.last_sync_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function rowToConnectorInstance(
  row: Record<string, unknown>,
): ConnectorInstance {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    connectorDefinitionId: String(row.connector_definition_id),
    name: String(row.name),
    status: row.status as ConnectorInstance["status"],
    config: parseJson(String(row.config_json), {}),
    syncSettings: parseJson<ConnectorSyncSettings>(
      String(row.sync_settings_json),
      { enabled: false, mode: "manual", schedule: null },
    ),
    dataEnvironmentId: row.data_environment_id
      ? String(row.data_environment_id)
      : null,
    lastSyncAt: row.last_sync_at ? String(row.last_sync_at) : null,
    lastSyncStatus: row.last_sync_status
      ? (row.last_sync_status as ConnectorInstance["lastSyncStatus"])
      : null,
    lastSyncMessage: row.last_sync_message
      ? String(row.last_sync_message)
      : null,
    healthStatus: row.health_status as ConnectorInstance["healthStatus"],
    healthMessage: row.health_message ? String(row.health_message) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function rowToCreditBalance(row: Record<string, unknown>): CreditBalance {
  return {
    companyId: String(row.company_id),
    balanceCents: Number(row.balance_cents),
    currency: String(row.currency),
    updatedAt: String(row.updated_at),
  };
}

export function rowToAuditEvent(row: Record<string, unknown>): AuditEvent {
  return {
    id: String(row.id),
    companyId: row.company_id ? String(row.company_id) : null,
    eventType: row.event_type as AuditEvent["eventType"],
    actor: String(row.actor),
    resourceType: row.resource_type ? String(row.resource_type) : null,
    resourceId: row.resource_id ? String(row.resource_id) : null,
    detail: parseJson(String(row.detail_json), {}),
    createdAt: String(row.created_at),
  };
}

export function rowToSyncHistory(row: Record<string, unknown>): SyncHistoryEntry {
  return {
    id: String(row.id),
    connectorInstanceId: String(row.connector_instance_id),
    companyId: String(row.company_id),
    status: row.status as SyncHistoryEntry["status"],
    startedAt: String(row.started_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
    itemsProcessed: Number(row.items_processed),
    itemsFailed: Number(row.items_failed),
    message: row.message ? String(row.message) : null,
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
