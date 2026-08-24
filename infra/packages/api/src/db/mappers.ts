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
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
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
    isExternal: Boolean(row.is_external),
    dataPlaneId: row.data_plane_id ? String(row.data_plane_id) : null,
    lastHealthCheckAt: row.last_health_check_at
      ? String(row.last_health_check_at)
      : null,
    lastHealthyAt: row.last_healthy_at ? String(row.last_healthy_at) : null,
    healthMessage: row.health_message ? String(row.health_message) : null,
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
