import type {
  ConnectorCatalogueStatus,
  ConnectorCategory,
  ConnectorCapability,
  ConnectorDefinition,
  SyncMode,
} from "@infra/shared";

export const CATEGORY_LABELS: Record<ConnectorCategory, string> = {
  cloud_storage: "Knowledge Sources",
  email: "Productivity",
  field_service: "Field Service / CRM",
  accounting: "Accounting & Finance",
  helpdesk: "Customer Support",
  ai_assistant: "AI Connections",
  messaging: "Communication Channels",
  api: "Custom Integrations",
};

export const CAPABILITY_LABELS: Record<ConnectorCapability, string> = {
  read: "Read",
  search: "Search",
  analyse: "Analyse",
  create: "Create",
  update: "Update",
  delete: "Delete",
  send: "Send",
  batch: "Batch",
  webhook: "Webhook",
  sync: "Sync",
  index: "Index",
  export: "Export",
  live_query: "Live data",
};

export const SYNC_MODE_LABELS: Record<SyncMode, string> = {
  manual: "Manual",
  scheduled: "Scheduled",
  webhook: "Webhook",
  incremental: "Incremental",
  live_api: "Live API",
};

export const STATUS_LABELS: Record<ConnectorCatalogueStatus, string> = {
  active: "Active",
  available: "Available",
  coming_soon: "Coming Soon",
  draft: "Draft",
};

export type CatalogueFilter = "all" | "product_ready" | "available" | "coming_soon";

export function getConnectorAction(
  status: ConnectorCatalogueStatus,
): "manage" | "connect" | "coming_soon" {
  if (status === "active") return "manage";
  if (status === "available") return "connect";
  return "coming_soon";
}

export function getConnectorActionLabel(
  status: ConnectorCatalogueStatus,
): string {
  switch (getConnectorAction(status)) {
    case "manage":
      return "Details";
    case "connect":
      return "Requires setup";
    default:
      return "Coming soon";
  }
}

export function filterConnectors(
  connectors: ConnectorDefinition[],
  query: string,
  statusFilter: CatalogueFilter,
  categoryFilter: ConnectorCategory | "all",
): ConnectorDefinition[] {
  const normalizedQuery = query.trim().toLowerCase();

  const filtered = connectors.filter((connector) => {
    if (statusFilter !== "all") {
      if (statusFilter === "product_ready" && connector.catalogueStatus !== "active") {
        return false;
      }
      if (
        statusFilter === "available" &&
        connector.catalogueStatus !== "available"
      ) {
        return false;
      }
      if (
        statusFilter === "coming_soon" &&
        connector.catalogueStatus !== "coming_soon" &&
        connector.catalogueStatus !== "draft"
      ) {
        return false;
      }
    }

    if (categoryFilter !== "all" && connector.category !== categoryFilter) {
      return false;
    }

    if (!normalizedQuery) return true;

    const haystack = [
      connector.name,
      connector.description,
      CATEGORY_LABELS[connector.category],
      connector.integrationType === "ai_channel"
        ? "AI channel interface"
        : "Business system",
      ...connector.capabilities.map((cap) => CAPABILITY_LABELS[cap]),
      ...connector.supportedSyncModes.map((mode) => SYNC_MODE_LABELS[mode]),
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(normalizedQuery);
  });

  return sortConnectorsForDisplay(filtered);
}

/** Custom API is an advanced fallback — show last in browse order. */
export function sortConnectorsForDisplay(
  connectors: ConnectorDefinition[],
): ConnectorDefinition[] {
  return [...connectors].sort((a, b) => {
    const aCustom = a.slug === "custom-api" ? 1 : 0;
    const bCustom = b.slug === "custom-api" ? 1 : 0;
    if (aCustom !== bCustom) return aCustom - bCustom;
    return a.name.localeCompare(b.name);
  });
}

export function getDevelopmentStatusMessage(
  connector: ConnectorDefinition,
): string {
  if (connector.catalogueStatus === "active") {
    return "This connector is operational in live INFRA environments. Company instances can be managed from the company detail view.";
  }
  if (connector.catalogueStatus === "available") {
    return "Connector framework is defined in INFRA. Per-company connection flows and credential storage will be enabled in a future release.";
  }
  if (connector.slug === "chatgpt") {
    return "ChatGPT is live through the single INFRA MCP gateway. Create a company AI connection and use the INFRA URL — never a company MCP URL.";
  }
  if (connector.integrationType === "ai_channel") {
    return "AI and messaging channels resolve to identity, company, permissions, interaction, usage, and audit. WhatsApp is designed, not activated.";
  }
  return "This integration is on the roadmap. Capabilities and sync modes shown reflect the intended design.";
}
