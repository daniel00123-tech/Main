import type {
  ConnectorCategory,
  ConnectorDefinition,
  ConnectorTaxonomyCategory,
} from "../types";

export const TAXONOMY_LABELS: Record<ConnectorTaxonomyCategory, string> = {
  knowledge_sources: "Knowledge Sources",
  accounting_finance: "Accounting & Finance",
  field_service_crm: "Field Service / CRM",
  customer_support: "Customer Support",
  productivity: "Productivity",
  ai_connections: "AI Connections",
  communication_channels: "Communication Channels",
  custom_integrations: "Custom Integrations",
};

const CATEGORY_TO_TAXONOMY: Record<ConnectorCategory, ConnectorTaxonomyCategory> = {
  cloud_storage: "knowledge_sources",
  email: "productivity",
  field_service: "field_service_crm",
  accounting: "accounting_finance",
  helpdesk: "customer_support",
  ai_assistant: "ai_connections",
  messaging: "communication_channels",
  api: "custom_integrations",
};

export function taxonomyForConnector(
  connector: Pick<ConnectorDefinition, "category" | "taxonomyCategory" | "integrationType">,
): ConnectorTaxonomyCategory {
  if (connector.taxonomyCategory) return connector.taxonomyCategory;
  if (connector.integrationType === "ai_channel") {
    return connector.category === "messaging"
      ? "communication_channels"
      : "ai_connections";
  }
  return CATEGORY_TO_TAXONOMY[connector.category];
}

export function taxonomyLabel(category: ConnectorTaxonomyCategory): string {
  return TAXONOMY_LABELS[category];
}
