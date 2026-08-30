/** Customer-facing connector health for portal overview surfaces. */

export type ConnectorCustomerHealthLabel =
  | "Connected"
  | "Needs attention"
  | "Disconnected"
  | "Authorisation expired"
  | "Configuration required";

export type ConnectorHealthSignals = {
  status: string;
  healthStatus?: string | null;
  authStatus?: string | null;
  syncHealth?: string | null;
  providerHealth?: string | null;
};

export type ConnectorOverviewCopyInput = {
  connectorDefinitionId: string;
  name: string;
  displayAccountName?: string | null;
  companyName?: string | null;
  lastVerifiedAt?: string | null;
};

const OVERVIEW_DESCRIPTIONS: Record<string, string> = {
  conn_google_drive: "Files and company knowledge",
  conn_xero: "Accounting and financial data",
  conn_microsoft_365: "OneDrive, SharePoint and email",
  conn_sharepoint: "SharePoint document libraries",
  conn_onedrive: "Company OneDrive files",
  conn_outlook_shared: "Approved shared mailboxes",
  conn_bigchange: "Field service jobs and engineers",
  conn_freshdesk: "Support tickets and customers",
};

/**
 * Maps connector instance signals to a compact health badge for customer UI.
 * States are product language — never "Configured" or raw lifecycle names.
 */
export function deriveConnectorCustomerHealth(
  instance: ConnectorHealthSignals,
): { badgeStatus: string; label: ConnectorCustomerHealthLabel } {
  const status = normalise(instance.status);
  const health = normalise(instance.healthStatus);
  const auth = normalise(instance.authStatus);
  const sync = normalise(instance.syncHealth);
  const provider = normalise(instance.providerHealth);

  if (auth === "auth_expired" || auth === "expired" || auth === "rotation_required") {
    return { badgeStatus: "warning", label: "Authorisation expired" };
  }

  if (
    health === "unhealthy" ||
    provider === "unhealthy" ||
    provider === "unavailable" ||
    status === "error" ||
    status === "failed" ||
    auth === "error" ||
    health === "degraded" ||
    provider === "degraded" ||
    status === "degraded" ||
    sync === "failed"
  ) {
    return { badgeStatus: "warning", label: "Needs attention" };
  }

  if (
    health === "healthy" ||
    provider === "healthy" ||
    status === "healthy" ||
    (auth === "connected" && (status === "configured" || status === "healthy" || configuredEnough(status)))
  ) {
    return { badgeStatus: "healthy", label: "Connected" };
  }

  if (
    status === "disabled" ||
    auth === "revoked"
  ) {
    return { badgeStatus: "not_configured", label: "Disconnected" };
  }

  if (
    status === "draft" ||
    auth === "not_configured" ||
    status === "not_configured" ||
    auth === "credentials_required" ||
    status === "credentials_required"
  ) {
    return { badgeStatus: "not_configured", label: "Configuration required" };
  }

  return { badgeStatus: "warning", label: "Needs attention" };
}

function configuredEnough(status: string): boolean {
  return status === "configured" || status === "active";
}

export function connectorOverviewDescription(connectorDefinitionId: string): string {
  return (
    OVERVIEW_DESCRIPTIONS[connectorDefinitionId] ??
    "Business data connected to your company"
  );
}

export function connectorOverviewTitle(input: ConnectorOverviewCopyInput): string {
  if (input.connectorDefinitionId === "conn_xero") {
    const org = input.displayAccountName?.trim();
    if (org) return `${org} · Xero`;
    if (input.companyName?.trim()) return `${input.companyName.trim()} · Xero`;
  }
  return input.name;
}

function normalise(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
