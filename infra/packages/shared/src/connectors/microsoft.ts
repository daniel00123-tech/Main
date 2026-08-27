/**
 * Microsoft Graph connector foundation for OneDrive, SharePoint, and Outlook shared mailboxes.
 * Uses Microsoft Graph API — not three unrelated integrations.
 */

export type MicrosoftSourceType = "onedrive" | "sharepoint" | "outlook_shared";

export type MicrosoftInclusionStatus = "included" | "excluded" | "available";

export type MicrosoftSyncStatus =
  | "pending"
  | "syncing"
  | "healthy"
  | "needs_attention"
  | "error"
  | "requires_authentication";

export type MicrosoftConnectorSource = {
  id: string;
  companyId: string;
  connectorInstanceId: string;
  sourceType: MicrosoftSourceType;
  externalId: string;
  displayName: string;
  pathOrUrl: string | null;
  mailboxAddress: string | null;
  inclusionStatus: MicrosoftInclusionStatus;
  syncStatus: MicrosoftSyncStatus;
  lastSyncAt: string | null;
  lastError: string | null;
};

/** Normalised knowledge provenance for Microsoft-sourced documents. */
export type MicrosoftKnowledgeProvenance = {
  connector: "microsoft_365";
  sourceType: MicrosoftSourceType;
  companyId: string;
  tenantId: string | null;
  driveId?: string | null;
  siteId?: string | null;
  mailboxAddress?: string | null;
  path: string | null;
  filename: string | null;
  subject?: string | null;
  externalItemId: string;
  modifiedAt: string | null;
  scope: MicrosoftInclusionStatus;
};

/** Least-privilege Graph scopes per component — never request broader than needed. */
export const MICROSOFT_GRAPH_SCOPES = {
  onedrive: ["Files.Read.All", "User.Read"],
  sharepoint: ["Sites.Read.All", "Files.Read.All"],
  outlook_shared: ["Mail.Read.Shared", "User.Read"],
} as const;

export const MICROSOFT_CONNECTOR_DEFINITION_IDS = [
  "conn_microsoft_365",
  "conn_onedrive",
  "conn_sharepoint",
  "conn_outlook_shared",
] as const;

export function isMicrosoftConnectorDefinition(id: string): boolean {
  return (MICROSOFT_CONNECTOR_DEFINITION_IDS as readonly string[]).includes(id);
}
