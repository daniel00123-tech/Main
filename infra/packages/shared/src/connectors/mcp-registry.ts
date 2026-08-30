/**
 * Platform connector registry — maps company-MCP connector records onto
 * INFRA catalogue instances. Tenant-agnostic: EL, HT, Caddington, and future
 * companies use the same mapping. Secrets never appear in these records.
 */

import { CONNECTOR_CATALOGUE, getConnectorById } from "./catalogue";
import { deriveConnectorCustomerHealth } from "./customer-health";
import type { ConnectorInstance } from "../types";

export const MCP_CONNECTOR_TYPE_TO_CATALOGUE_ID: Record<string, string> = {
  microsoft_365: "conn_microsoft_365",
  microsoft365: "conn_microsoft_365",
  sharepoint: "conn_sharepoint",
  onedrive: "conn_onedrive",
  outlook_shared_mailbox: "conn_outlook_shared",
  outlook_shared: "conn_outlook_shared",
  outlook_calendar: "conn_outlook_shared",
  xero: "conn_xero",
  bigchange: "conn_bigchange",
  commusoft: "conn_commusoft",
  google_drive: "conn_google_drive",
  googledrive: "conn_google_drive",
  freshdesk: "conn_freshdesk",
};

export const MICROSOFT_CHILD_CONNECTOR_TYPES = new Set([
  "sharepoint",
  "onedrive",
  "outlook_shared_mailbox",
  "outlook_shared",
  "outlook_calendar",
]);

export const CUSTOMER_FACING_CONNECTOR_IDS = new Set([
  "conn_microsoft_365",
  "conn_xero",
  "conn_bigchange",
  "conn_commusoft",
  "conn_google_drive",
  "conn_freshdesk",
]);

export type McpRegistryHealth = "healthy" | "degraded" | "unhealthy" | "unknown";

export type McpRegistryConnector = {
  connectorType: string;
  connectorInstance?: string | null;
  configured?: boolean;
  connected?: boolean;
  enabled?: boolean;
  status?: string | null;
  health?: McpRegistryHealth | string | null;
  lastVerified?: string | null;
  lastSuccessfulConnection?: string | null;
  label?: string | null;
  category?: string | null;
  authenticationConfigured?: boolean;
  metadata?: Record<string, unknown> | null;
  source?: string | null;
};

export type PlatformRegistryRecord = {
  connectorType: string;
  catalogueId: string;
  instanceKey: string;
  configured: boolean;
  connected: boolean;
  health: McpRegistryHealth;
  lastVerified: string | null;
  label: string;
  category: string;
  source: string;
  metadata: Record<string, unknown>;
};

const CONNECTED_MCP_STATUSES = new Set([
  "configured",
  "active",
  "healthy",
  "connected",
]);

export function catalogueIdForMcpConnectorType(connectorType: string): string | null {
  const key = connectorType.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return MCP_CONNECTOR_TYPE_TO_CATALOGUE_ID[key] ?? null;
}

export function isMicrosoftFamilyType(connectorType: string): boolean {
  const key = connectorType.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return key === "microsoft_365" || key === "microsoft365" || MICROSOFT_CHILD_CONNECTOR_TYPES.has(key);
}

export function mcpConnectorLooksConnected(input: McpRegistryConnector): boolean {
  if (input.connected === true) return true;
  if (input.configured === true && input.connected !== false) return true;
  if (input.authenticationConfigured === true && input.enabled !== false) return true;
  const status = (input.status ?? "").toLowerCase();
  return CONNECTED_MCP_STATUSES.has(status);
}

export function normaliseMcpHealth(value: string | null | undefined): McpRegistryHealth {
  const health = (value ?? "").toLowerCase();
  if (health === "healthy" || health === "ok" || health === "pass") return "healthy";
  if (health === "degraded" || health === "partial") return "degraded";
  if (health === "unhealthy" || health === "error" || health === "fail") return "unhealthy";
  return "unknown";
}

function publicMetadata(raw: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  const blocked = /secret|token|password|refresh|credential|bearer|key/i;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (blocked.test(key)) continue;
    if (typeof value === "string" && blocked.test(value) && value.length > 20) continue;
    out[key] = value;
  }
  return out;
}

export function mapMcpConnectorsToRegistryRecords(input: {
  connectors: McpRegistryConnector[];
  source?: string | null;
}): PlatformRegistryRecord[] {
  const source = input.source?.trim() || "company_mcp";
  const records = new Map<string, PlatformRegistryRecord>();

  for (const connector of input.connectors) {
    const catalogueId = catalogueIdForMcpConnectorType(connector.connectorType);
    if (!catalogueId) continue;
    const definition = getConnectorById(catalogueId);
    const connected = mcpConnectorLooksConnected(connector);
    const configured = connector.configured === true || connected || Boolean(connector.authenticationConfigured);
    const health = connected && normaliseMcpHealth(connector.health) === "unknown"
      ? "healthy"
      : normaliseMcpHealth(connector.health);
    const lastVerified = connector.lastVerified ?? connector.lastSuccessfulConnection ?? null;
    const record: PlatformRegistryRecord = {
      connectorType: connector.connectorType,
      catalogueId,
      instanceKey: connector.connectorInstance?.trim() || "default",
      configured,
      connected,
      health,
      lastVerified,
      label: connector.label?.trim() || definition?.name || connector.connectorType,
      category: connector.category?.trim() || definition?.category || "integration",
      source,
      metadata: publicMetadata({
        ...(connector.metadata ?? {}),
        authenticationConfigured: connector.authenticationConfigured ?? configured,
      }),
    };
    records.set(`${catalogueId}:${record.instanceKey}`, record);
  }

  const microsoftChildren = input.connectors.filter((item) => isMicrosoftFamilyType(item.connectorType));
  const microsoftConnected = microsoftChildren.some((item) => mcpConnectorLooksConnected(item));
  const microsoftConfigured = microsoftChildren.some(
    (item) => item.configured === true || item.authenticationConfigured === true || mcpConnectorLooksConnected(item),
  );
  if (microsoftConfigured && !records.has("conn_microsoft_365:default")) {
    const childHealth = microsoftChildren
      .map((item) => normaliseMcpHealth(item.health))
      .find((item) => item !== "unknown");
    const lastVerified =
      microsoftChildren
        .map((item) => item.lastVerified ?? item.lastSuccessfulConnection)
        .find((item): item is string => Boolean(item)) ?? null;
    records.set("conn_microsoft_365:default", {
      connectorType: "microsoft_365",
      catalogueId: "conn_microsoft_365",
      instanceKey: "default",
      configured: microsoftConfigured,
      connected: microsoftConnected,
      health: microsoftConnected ? childHealth ?? "healthy" : childHealth ?? "unknown",
      lastVerified,
      label: "Microsoft 365",
      category: "cloud_storage",
      source,
      metadata: {
        components: microsoftChildren.map((item) => item.connectorType),
        rolledUp: true,
      },
    });
  }

  return [...records.values()];
}

export type ExistingRegistryInstance = Pick<
  ConnectorInstance,
  | "id"
  | "companyId"
  | "connectorDefinitionId"
  | "status"
  | "authStatus"
  | "managedBy"
  | "healthStatus"
  | "providerHealth"
>;

export type RegistrySyncDecision =
  | { action: "skip"; reason: string }
  | { action: "upsert"; catalogueId: string; promoteFromDraft: boolean };

/**
 * INFRA-managed live OAuth stays authoritative unless the company MCP
 * independently reports the same connector connected.
 */
export function decideRegistrySync(input: {
  existing: ExistingRegistryInstance | null;
  incoming: PlatformRegistryRecord;
}): RegistrySyncDecision {
  const existing = input.existing;
  if (
    existing?.managedBy === "infra" &&
    existing.authStatus === "connected" &&
    !input.incoming.connected
  ) {
    return { action: "skip", reason: "infra_managed_oauth_authoritative" };
  }
  return {
    action: "upsert",
    catalogueId: input.incoming.catalogueId,
    promoteFromDraft: !existing || existing.status === "draft" || input.incoming.connected,
  };
}

export function registryInstanceId(companyId: string, catalogueId: string): string {
  return `ci_${companyId}_${catalogueId.replace(/^conn_/, "")}`;
}

export function isCustomerFacingConnectorId(connectorDefinitionId: string): boolean {
  if (CUSTOMER_FACING_CONNECTOR_IDS.has(connectorDefinitionId)) return true;
  const definition = getConnectorById(connectorDefinitionId);
  return Boolean(definition && !definition.parentConnectorId && definition.integrationType === "business_system");
}

/** Overview / checklist: hide Microsoft children when the parent is present. */
export function customerFacingConnectorInstances<T extends Pick<ConnectorInstance, "connectorDefinitionId" | "status">>(
  instances: T[],
): T[] {
  const parentPresent = new Set(
    instances
      .filter((item) => item.status !== "draft" && CUSTOMER_FACING_CONNECTOR_IDS.has(item.connectorDefinitionId))
      .map((item) => item.connectorDefinitionId),
  );
  return instances.filter((item) => {
    if (item.status === "draft") return false;
    const definition = getConnectorById(item.connectorDefinitionId);
    if (definition?.parentConnectorId && parentPresent.has(definition.parentConnectorId)) {
      return false;
    }
    return isCustomerFacingConnectorId(item.connectorDefinitionId) || !definition?.parentConnectorId;
  });
}

export function catalogueHasDefinition(id: string): boolean {
  return CONNECTOR_CATALOGUE.some((item) => item.id === id);
}
