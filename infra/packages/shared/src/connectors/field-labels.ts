/** Customer-facing labels for schema-driven connector setup. */
export const CONNECTOR_FIELD_LABELS: Record<string, string> = {
  serviceAccountJson: "Service account JSON",
  delegatedUser: "Delegated user email",
  folderIds: "Folder IDs",
  includeSharedDrives: "Include shared drives",
  tenantId: "Directory / tenant ID",
  clientId: "Client ID",
  clientSecret: "Client secret",
  siteUrls: "SharePoint site URLs",
  libraryNames: "Libraries",
  driveIds: "Drive IDs",
  mailboxAddresses: "Mailbox addresses",
  folders: "Folders",
  apiKey: "API key",
  username: "Username",
  password: "Password",
  baseUrl: "Service URL",
  authMode: "Sign-in method",
  syncEntities: "Data to sync",
  refreshToken: "Refresh token",
  domain: "Helpdesk domain",
  authType: "Authentication type",
  bearerToken: "Access token",
  endpoints: "Endpoints",
};

export function connectorFieldLabel(name: string): string {
  if (CONNECTOR_FIELD_LABELS[name]) return CONNECTOR_FIELD_LABELS[name];
  return name
    .replace(/([A-Z])/g, " $1")
    .replace(/[_-]/g, " ")
    .replace(/^\w/, (letter) => letter.toUpperCase())
    .trim();
}
