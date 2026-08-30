import type { ConnectorDefinition } from "./types";

export interface NotConfiguredResponse {
  status: "not_configured";
  connector: string;
  message: string;
}

export function notConfiguredConnector(
  connectorType: string,
  message?: string
): NotConfiguredResponse {
  return {
    status: "not_configured",
    connector: connectorType,
    message:
      message ??
      `${connectorType} is not configured for this company MCP.`,
  };
}

export function notConfiguredConnectorDefinition(
  connectorType: string,
  company: string,
  label: string,
  category = "integration"
): ConnectorDefinition {
  return {
    connectorType,
    connectorVersion: "0.1.0",
    company,
    label,
    category,
    enabled: false,
    status: "not_configured",
    authenticationConfigured: false,
    capabilities: [],
    readLevel: "none",
    writeLevel: "none",
    sendLevel: "none",
    batchCapable: false,
    health: "unknown",
  };
}

export function notConfiguredToolPayload(
  tool: string,
  resource?: string
): { status: "not_configured"; tool: string; message: string } {
  return {
    status: "not_configured",
    tool,
    message: resource
      ? `${tool} is unavailable because ${resource} is not configured.`
      : `${tool} is not configured for this company MCP.`,
  };
}
