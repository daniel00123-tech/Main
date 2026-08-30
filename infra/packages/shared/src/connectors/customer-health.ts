/** Customer-facing connector health for portal overview surfaces. */

export type ConnectorCustomerHealthLabel =
  | "Healthy"
  | "Attention needed"
  | "Disconnected"
  | "Checking…"
  | "Error";

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
 * Never surfaces lifecycle labels such as "Configured" or "Connected".
 */
export function deriveConnectorCustomerHealth(
  instance: ConnectorHealthSignals,
): { badgeStatus: string; label: ConnectorCustomerHealthLabel } {
  const status = normalise(instance.status);
  const health = normalise(instance.healthStatus);
  const auth = normalise(instance.authStatus);
  const sync = normalise(instance.syncHealth);
  const provider = normalise(instance.providerHealth);

  if (
    health === "unhealthy" ||
    provider === "unhealthy" ||
    provider === "unavailable" ||
    status === "error" ||
    status === "failed" ||
    auth === "error"
  ) {
    return { badgeStatus: "error", label: "Error" };
  }

  if (
    health === "degraded" ||
    provider === "degraded" ||
    status === "degraded" ||
    auth === "auth_expired" ||
    auth === "rotation_required" ||
    auth === "expired" ||
    sync === "failed"
  ) {
    return { badgeStatus: "warning", label: "Attention needed" };
  }

  if (health === "healthy" || provider === "healthy" || status === "healthy") {
    return { badgeStatus: "healthy", label: "Healthy" };
  }

  if (
    status === "draft" ||
    auth === "revoked" ||
    status === "disabled" ||
    auth === "not_configured" ||
    status === "not_configured" ||
    auth === "credentials_required"
  ) {
    return { badgeStatus: "not_configured", label: "Disconnected" };
  }

  if (auth === "configuring" || status === "syncing" || sync === "running") {
    return { badgeStatus: "pending", label: "Checking…" };
  }

  if (auth === "connected" && health === "unknown" && !provider) {
    return { badgeStatus: "pending", label: "Checking…" };
  }

  if (status === "configured") {
    return { badgeStatus: "pending", label: "Checking…" };
  }

  return { badgeStatus: "warning", label: "Attention needed" };
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
