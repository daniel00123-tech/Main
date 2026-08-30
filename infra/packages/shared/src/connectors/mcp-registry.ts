/**
 * Platform connector registry — maps company-MCP connector records onto
 * INFRA catalogue instances. Tenant-agnostic: EL, HT, Caddington, and future
 * companies use the same mapping. Secrets never appear in these records.
 */

import { CONNECTOR_CATALOGUE, getConnectorById, getConnectorBySlug } from "./catalogue";
import type { ConnectorDefinition, ConnectorInstance } from "../types";

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

/** Connector row as advertised by a company Business MCP (`system_health` / `/status`). */
export type McpAdvertisedConnector = {
  type: string;
  status?: string | null;
  enabled?: boolean | null;
  version?: string | null;
  health?: string | null;
  authenticationConfigured?: boolean | null;
  connected?: boolean | null;
  label?: string | null;
};

export type McpXeroPolicy = {
  configured?: boolean | null;
  connected?: boolean | null;
  organisationName?: string | null;
  expectedOrganisation?: string | null;
  tenantId?: string | null;
  lastApiOk?: boolean | null;
  lastApiAt?: string | null;
  tokenHealth?: string | null;
  lastError?: string | null;
};

export type McpMicrosoftPolicy = {
  configured?: boolean | null;
  approvedMailboxes?: string[] | null;
  sharePointHostname?: string | null;
  tenantIdConfigured?: boolean | null;
  clientIdConfigured?: boolean | null;
  clientSecretConfigured?: boolean | null;
};

export type McpConnectorSnapshot = {
  connectors: McpAdvertisedConnector[];
  xero?: McpXeroPolicy | null;
  microsoft?: McpMicrosoftPolicy | null;
};

export type MirroredConnectorState = {
  connected: boolean;
  status: "healthy" | "draft";
  authStatus: "connected" | "not_configured";
  healthStatus: "healthy" | "unknown";
  providerHealth: "healthy" | "unknown";
  healthMessage: string;
  displayAccountName: string | null;
  externalAccountId: string | null;
};

const MICROSOFT_MCP_TYPES = new Set([
  "sharepoint",
  "onedrive",
  "outlook_shared_mailbox",
  "outlook-shared-mailbox",
  "outlook_calendar",
  "outlook-calendar",
  "microsoft_365",
  "microsoft-365",
  "microsoft",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function normaliseMcpType(type: string): string {
  return type.trim().toLowerCase().replace(/[\s.]+/g, "_");
}

function slugCandidates(type: string): string[] {
  const normalised = normaliseMcpType(type);
  const hyphenated = normalised.replace(/_/g, "-");
  const aliases: Record<string, string[]> = {
    outlook_shared_mailbox: ["outlook-shared-mailbox"],
    "outlook-shared-mailbox": ["outlook-shared-mailbox"],
    microsoft: ["microsoft-365"],
    microsoft_365: ["microsoft-365"],
    google_drive: ["google-drive"],
    googledrive: ["google-drive"],
  };
  return [...new Set([hyphenated, normalised, ...(aliases[normalised] ?? [])])];
}

/** Map a company-MCP connector type onto the INFRA catalogue. Unknown types are ignored. */
export function resolveCatalogueConnector(type: string): ConnectorDefinition | null {
  if (!type.trim()) return null;
  if (type.startsWith("conn_")) {
    return getConnectorById(type) ?? null;
  }
  for (const slug of slugCandidates(type)) {
    const match = getConnectorBySlug(slug);
    if (match) return match;
  }
  return null;
}

export function isMicrosoftMcpType(type: string): boolean {
  const normalised = normaliseMcpType(type);
  return MICROSOFT_MCP_TYPES.has(normalised) || MICROSOFT_MCP_TYPES.has(normalised.replace(/_/g, "-"));
}

function advertisedReady(connector: McpAdvertisedConnector): boolean {
  const status = (connector.status ?? "").toLowerCase();
  const health = (connector.health ?? "").toLowerCase();
  if (connector.enabled === false) return false;
  if (connector.authenticationConfigured === false) return false;
  if (connector.connected === false) return false;
  if (["disabled", "not_configured", "draft", "missing"].includes(status)) return false;
  if (["unhealthy", "error", "failed"].includes(health)) return false;
  return (
    ["configured", "active", "healthy", "connected"].includes(status) ||
    health === "healthy" ||
    connector.connected === true ||
    connector.authenticationConfigured === true
  );
}

/**
 * Derive portal mirror state from an MCP-advertised connector plus optional
 * provider policy overlays. Never marks Connected without MCP evidence.
 */
export function deriveMirroredConnectorState(
  connector: McpAdvertisedConnector,
  overlays: { xero?: McpXeroPolicy | null; microsoft?: McpMicrosoftPolicy | null } = {},
): MirroredConnectorState {
  const type = normaliseMcpType(connector.type);
  const definition = resolveCatalogueConnector(connector.type);
  const disconnected = (message: string): MirroredConnectorState => ({
    connected: false,
    status: "draft",
    authStatus: "not_configured",
    healthStatus: "unknown",
    providerHealth: "unknown",
    healthMessage: message,
    displayAccountName: null,
    externalAccountId: null,
  });

  if (type === "xero" || definition?.id === "conn_xero") {
    const xero = overlays.xero;
    if (xero) {
      if (!xero.connected) {
        return disconnected(
          xero.configured
            ? "Xero app is configured on the company MCP but no organisation is connected."
            : "Xero is not connected on the company MCP.",
        );
      }
      const org = asString(xero.organisationName);
      const lastApi =
        xero.lastApiOk === false
          ? "Last API call failed"
          : xero.lastApiAt
            ? `Last API ${xero.lastApiAt}`
            : "Organisation connected";
      return {
        connected: true,
        status: "healthy",
        authStatus: "connected",
        healthStatus: xero.lastApiOk === false ? "unknown" : "healthy",
        providerHealth: xero.lastApiOk === false ? "unknown" : "healthy",
        healthMessage: org ? `Connected to ${org} · ${lastApi}` : `Xero connected · ${lastApi}`,
        displayAccountName: org,
        externalAccountId: asString(xero.tenantId),
      };
    }
  }

  if (isMicrosoftMcpType(connector.type) || definition?.id === "conn_microsoft_365") {
    const microsoft = overlays.microsoft;
    if (microsoft && microsoft.configured === false) {
      return disconnected("Microsoft 365 is not configured on the company MCP.");
    }
    if (microsoft?.configured === true && advertisedReady(connector)) {
      const host = asString(microsoft.sharePointHostname);
      const mailboxes = (microsoft.approvedMailboxes ?? []).filter(Boolean);
      const detail = mailboxes.length
        ? `Approved mailboxes: ${mailboxes.slice(0, 3).join(", ")}`
        : host
          ? host
          : "Graph credentials present";
      return {
        connected: true,
        status: "healthy",
        authStatus: "connected",
        healthStatus: "healthy",
        providerHealth: "healthy",
        healthMessage: `Microsoft 365 healthy · ${detail}`,
        displayAccountName: host,
        externalAccountId: null,
      };
    }
  }

  if (!advertisedReady(connector)) {
    return disconnected("Not configured on the company MCP.");
  }

  const label = asString(connector.label) ?? definition?.name ?? connector.type;
  return {
    connected: true,
    status: "healthy",
    authStatus: "connected",
    healthStatus: connector.health === "healthy" || !connector.health ? "healthy" : "unknown",
    providerHealth: connector.health === "unhealthy" ? "unknown" : "healthy",
    healthMessage: `${label} reported healthy by the company MCP`,
    displayAccountName: null,
    externalAccountId: null,
  };
}

function readConnectors(value: unknown): McpAdvertisedConnector[] {
  if (!Array.isArray(value)) return [];
  const out: McpAdvertisedConnector[] = [];
  for (const item of value) {
    const row = asRecord(item);
    if (!row) continue;
    const type = asString(row.type) ?? asString(row.code) ?? asString(row.connectorType);
    if (!type) continue;
    out.push({
      type,
      status: asString(row.status),
      enabled: asBoolean(row.enabled),
      version: asString(row.version) ?? asString(row.connectorVersion),
      health: asString(row.health),
      authenticationConfigured: asBoolean(row.authenticationConfigured),
      connected: asBoolean(row.connected),
      label: asString(row.label) ?? asString(row.name),
    });
  }
  return out;
}

function readXero(value: unknown): McpXeroPolicy | null {
  const row = asRecord(value);
  if (!row) return null;
  return {
    configured: asBoolean(row.configured),
    connected: asBoolean(row.connected),
    organisationName: asString(row.organisationName) ?? asString(row.organisation),
    expectedOrganisation: asString(row.expectedOrganisation),
    tenantId: asString(row.tenantId),
    lastApiOk: asBoolean(row.lastApiOk),
    lastApiAt: asString(row.lastApiAt),
    tokenHealth: asString(row.tokenHealth),
    lastError: asString(row.lastError),
  };
}

function readMicrosoft(value: unknown): McpMicrosoftPolicy | null {
  const row = asRecord(value);
  if (!row) return null;
  const mailboxes = Array.isArray(row.approvedMailboxes)
    ? row.approvedMailboxes.map((item) => asString(item)).filter((item): item is string => Boolean(item))
    : null;
  return {
    configured: asBoolean(row.configured),
    approvedMailboxes: mailboxes,
    sharePointHostname: asString(row.sharePointHostname),
    tenantIdConfigured: asBoolean(row.tenantIdConfigured),
    clientIdConfigured: asBoolean(row.clientIdConfigured),
    clientSecretConfigured: asBoolean(row.clientSecretConfigured),
  };
}

/** Parse `system_health` or public `/status` JSON from a company Business MCP. */
export function parseMcpConnectorSnapshot(payload: unknown): McpConnectorSnapshot | null {
  const root = asRecord(payload);
  if (!root) return null;

  const connectors =
    readConnectors(root.connectors) ||
    readConnectors(asRecord(root.structuredData)?.connectors);

  const xero = readXero(root.xero);
  const microsoft = readMicrosoft(root.microsoft);

  if (connectors.length === 0 && !xero && !microsoft) return null;
  return { connectors, xero, microsoft };
}

export function deriveStatusUrlFromMcpEndpoint(endpointUrl: string): string | null {
  try {
    const url = new URL(endpointUrl);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    url.pathname = path === "/mcp" || path.endsWith("/mcp") ? path.replace(/\/mcp$/, "/status") : "/status";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}
