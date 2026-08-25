import type {
  ConnectorAuthStatus,
  ConnectorInstance,
  ConnectorProviderHealth,
  ConnectorSyncHealth,
} from "@infra/shared";

export function deriveAuthStatus(instance: ConnectorInstance): ConnectorAuthStatus {
  if (instance.authStatus) return instance.authStatus;
  if (instance.status === "disabled") return "revoked";
  if (instance.status === "error") return "error";
  if (instance.status === "draft") return "not_configured";
  if (instance.status === "configured" || instance.status === "syncing") {
    return "configuring";
  }
  if (instance.status === "healthy" || instance.managedBy === "company_mcp") {
    return "connected";
  }
  if (instance.credentialRefId) return "credentials_required";
  return "not_configured";
}

export function deriveSyncHealth(instance: ConnectorInstance): ConnectorSyncHealth {
  if (instance.syncHealth) return instance.syncHealth;
  if (instance.lastSyncStatus === "failed") return "failed";
  if (instance.lastSyncStatus === "running") return "running";
  if (instance.lastSyncStatus === "completed") return "completed";
  if (instance.lastSyncAt) return "idle";
  if (instance.managedBy === "company_mcp") return "unknown";
  return "not_applicable";
}

export function deriveProviderHealth(
  instance: ConnectorInstance,
): ConnectorProviderHealth {
  if (instance.providerHealth) return instance.providerHealth;
  if (instance.healthStatus === "healthy") return "healthy";
  if (instance.healthStatus === "degraded") return "degraded";
  if (instance.healthStatus === "unhealthy") return "unavailable";
  return "unknown";
}

/**
 * Combined operational label. Auth and sync stay independently visible.
 * A valid OAuth session with a failed sync is "Degraded", not "Disconnected".
 */
export function deriveConnectorPresentation(instance: ConnectorInstance): {
  authStatus: ConnectorAuthStatus;
  syncHealth: ConnectorSyncHealth;
  providerHealth: ConnectorProviderHealth;
  label: string;
} {
  const authStatus = deriveAuthStatus(instance);
  const syncHealth = deriveSyncHealth(instance);
  const providerHealth = deriveProviderHealth(instance);

  let label = "Not configured";
  if (authStatus === "connected" && syncHealth === "failed") {
    label = "Connected · sync failed";
  } else if (authStatus === "connected" && providerHealth === "degraded") {
    label = "Connected · degraded";
  } else if (authStatus === "connected") {
    label = instance.managedBy === "company_mcp" ? "Managed by Business MCP" : "Connected";
  } else if (authStatus === "auth_expired") {
    label = "Authentication expired";
  } else if (authStatus === "rotation_required") {
    label = "Rotation required";
  } else if (authStatus === "configuring") {
    label = "Configuring";
  } else if (authStatus === "revoked") {
    label = "Disconnected";
  } else if (authStatus === "error") {
    label = "Error";
  }

  return { authStatus, syncHealth, providerHealth, label };
}

export const WRITE_RISK_CLASSES = new Set([
  "write",
  "delete",
  "batch_write",
  "external_send",
  "financial_action",
  "high_risk",
]);

export function isWriteRiskClass(riskClass: string): boolean {
  return WRITE_RISK_CLASSES.has(riskClass);
}

export function isFinancialRiskClass(riskClass: string): boolean {
  return riskClass === "financial_action";
}
