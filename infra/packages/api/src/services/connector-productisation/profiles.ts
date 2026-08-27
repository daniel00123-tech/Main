/**
 * Connector productisation profiles — Xero, Microsoft 365, Google Drive.
 */

import type { ConnectorProductisationProfile } from "@infra/shared";

export const CONNECTOR_PRODUCTISATION_PROFILES: ConnectorProductisationProfile[] = [
  {
    definitionId: "conn_xero",
    slug: "xero",
    selfServiceLevel: "full",
    managedBy: "infra",
    steps: [
      "prerequisites",
      "connect",
      "authorize",
      "select_account",
      "test_connection",
      "activate",
    ],
    portalRoute: null,
  },
  {
    definitionId: "conn_microsoft_365",
    slug: "microsoft-365",
    selfServiceLevel: "partial",
    managedBy: "infra",
    steps: [
      "prerequisites",
      "connect",
      "authorize",
      "discover_sources",
      "configure_scope",
      "test_connection",
      "activate",
    ],
    portalRoute: "microsoft-365",
  },
  {
    definitionId: "conn_google_drive",
    slug: "google-drive",
    selfServiceLevel: "mcp_managed",
    managedBy: "company_mcp",
    steps: ["prerequisites", "mcp_managed_notice", "test_connection", "activate"],
    portalRoute: null,
  },
];

export function getProductisationProfile(definitionId: string): ConnectorProductisationProfile | null {
  return CONNECTOR_PRODUCTISATION_PROFILES.find((p) => p.definitionId === definitionId) ?? null;
}

export function listProductisationProfiles(): ConnectorProductisationProfile[] {
  return CONNECTOR_PRODUCTISATION_PROFILES;
}
