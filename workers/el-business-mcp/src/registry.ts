import { EL_IDENTITY } from "./company-config";
import { MCP_NAME } from "./constants";
import type { Env } from "./env";
import { elConnectorDefinitions } from "./connectors";
import { loadMicrosoftConfig, publicMicrosoftPolicy } from "./microsoft/config";
import { xeroPublicStatus } from "./xero/verify";

export type PlatformRegistryConnector = {
  connectorType: string;
  connectorInstance: string;
  configured: boolean;
  connected: boolean;
  enabled: boolean;
  status: string;
  health: "healthy" | "degraded" | "unhealthy" | "unknown";
  lastVerified: string | null;
  label: string;
  category: string;
  authenticationConfigured: boolean;
  metadata: Record<string, unknown>;
  source: string;
};

function healthFromStatus(status: string, connected: boolean): PlatformRegistryConnector["health"] {
  if (connected || status === "configured" || status === "active") return "healthy";
  if (status === "error") return "unhealthy";
  if (status === "degraded") return "degraded";
  return "unknown";
}

export async function elPlatformRegistrySnapshot(env: Env): Promise<{
  company: string;
  companySlug: string;
  source: string;
  connectors: PlatformRegistryConnector[];
}> {
  const definitions = elConnectorDefinitions(env);
  const microsoft = publicMicrosoftPolicy(loadMicrosoftConfig(env));
  const xero = await xeroPublicStatus(env);
  const source = MCP_NAME;
  const now = new Date().toISOString();

  const connectors: PlatformRegistryConnector[] = definitions.map((definition) => {
    const isXero = definition.connectorType === "xero";
    const connected = isXero
      ? Boolean(xero.connected)
      : definition.status === "configured" || definition.authenticationConfigured;
    const configured = isXero ? Boolean(xero.configured || connected) : connected || definition.enabled;
    return {
      connectorType: definition.connectorType,
      connectorInstance: "default",
      configured,
      connected: isXero ? Boolean(xero.connected || (xero.configured && definition.status === "configured")) : connected,
      enabled: definition.enabled,
      status: connected || (isXero && xero.configured) ? "configured" : definition.status,
      health: healthFromStatus(definition.status, connected || (isXero && Boolean(xero.connected))),
      lastVerified: connected || (isXero && xero.lastApiAt) ? xero.lastApiAt ?? now : null,
      label: definition.label,
      category: definition.category,
      authenticationConfigured: definition.authenticationConfigured,
      metadata: isXero
        ? {
            organisationName: xero.organisationName,
            tokenHealth: xero.tokenHealth,
          }
        : {},
      source,
    };
  });

  if (microsoft.configured && !connectors.some((item) => item.connectorType === "microsoft_365")) {
    connectors.unshift({
      connectorType: "microsoft_365",
      connectorInstance: "default",
      configured: true,
      connected: true,
      enabled: true,
      status: "configured",
      health: "healthy",
      lastVerified: now,
      label: "Microsoft 365",
      category: "cloud_storage",
      authenticationConfigured: true,
      metadata: {
        sharePointHostname: microsoft.sharePointHostname,
        approvedMailboxes: microsoft.approvedMailboxes,
        components: ["sharepoint", "onedrive", "outlook_shared_mailbox", "outlook_calendar"],
      },
      source,
    });
  }

  return {
    company: EL_IDENTITY.company,
    companySlug: "el-business",
    source,
    connectors,
  };
}
