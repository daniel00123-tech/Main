import { getConnectorById, getConnectorBySlug } from "./catalogue";
import type { ConnectorDefinition } from "../types";

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
