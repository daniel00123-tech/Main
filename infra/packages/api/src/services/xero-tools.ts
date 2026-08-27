import {
  CONNECTOR_ERROR_CODES,
  XERO_TOOL_CONTRACTS,
  XERO_WRITE_SCOPES,
  customerConnectorError,
  missingScopesForTier,
  tierFromGrantedScopes,
} from "@infra/shared";
import type { Env } from "../env";
import { getConnectorInstance, listConnectorInstances } from "./control-plane";
import { FINANCIAL_WRITES_ENABLED } from "./approvals";

export const XERO_NON_BILLABLE_ACTIONS = new Set([
  "xero.health",
  "xero.token_refresh",
  "system.health",
]);

export function isXeroNonBillableAction(action?: string | null, toolName?: string | null): boolean {
  if (action && XERO_NON_BILLABLE_ACTIONS.has(action)) return true;
  if (toolName === "xero_connection_test") return true;
  return false;
}

export function xeroToolContract(toolName: string) {
  return XERO_TOOL_CONTRACTS.find(
    (tool) => tool.mcpToolName === toolName || tool.name === toolName,
  );
}

export function isXeroToolName(toolName: string): boolean {
  return Boolean(xeroToolContract(toolName)) || toolName.startsWith("xero_");
}

export function isXeroWriteToolName(toolName: string): boolean {
  const contract = xeroToolContract(toolName);
  return Boolean(contract && contract.riskClass !== "low_risk");
}

export function xeroActionForTool(toolName: string): {
  action: string;
  riskClass: string;
  usesExecutionPlan?: boolean;
} | null {
  const contract = xeroToolContract(toolName);
  if (!contract) return null;
  return {
    action: contract.action,
    riskClass: contract.riskClass,
    usesExecutionPlan: contract.usesExecutionPlan,
  };
}

function connectedXeroInstance(
  instances: Awaited<ReturnType<typeof listConnectorInstances>>,
) {
  return (
    instances.find(
      (row) =>
        row.connectorDefinitionId === "conn_xero" &&
        row.authStatus === "connected" &&
        Boolean(row.externalAccountId),
    ) ?? null
  );
}

function grantedScopes(instance: { capabilitiesEnabled?: string[]; config?: Record<string, unknown> }): string[] {
  if (Array.isArray(instance.capabilitiesEnabled) && instance.capabilitiesEnabled.length) {
    return instance.capabilitiesEnabled.map(String);
  }
  const fromConfig = instance.config?.grantedScopes;
  return Array.isArray(fromConfig) ? fromConfig.map(String) : [];
}

/**
 * Validates tenant-bound Xero connector state before forwarding to Company MCP.
 * Never invents accounting data. Write tools pass validation but remain blocked downstream.
 */
export async function prepareXeroMcpExecution(input: {
  env: Env;
  companyId: string;
  toolName: string;
}): Promise<
  | {
      ok: true;
      instanceId: string;
      mcpToolName: string;
      connected: true;
      scopeTier: "read" | "write";
      writesEnabled: boolean;
    }
  | {
      ok: false;
      status: 409;
      body: ReturnType<typeof customerConnectorError>;
      inventsData: false;
      code: string;
    }
> {
  const contract = xeroToolContract(input.toolName);
  if (!contract || !contract.implemented) {
    return fail(CONNECTOR_ERROR_CODES.XERO_MCP_UNAVAILABLE);
  }

  const instances = await listConnectorInstances(input.env.DB, input.companyId);
  const instance = connectedXeroInstance(instances);
  if (!instance) {
    return fail(CONNECTOR_ERROR_CODES.CONNECTOR_NOT_CONNECTED);
  }

  const fresh = await getConnectorInstance(input.env.DB, instance.id);
  if (!fresh || fresh.companyId !== input.companyId) {
    return fail(CONNECTOR_ERROR_CODES.CREDENTIAL_REF_FORBIDDEN);
  }

  const scopes = grantedScopes(fresh);
  const scopeTier = tierFromGrantedScopes(scopes);

  if (contract.requiresWriteScopes) {
    const missing = missingScopesForTier(scopes, "write");
    if (missing.length > 0) {
      return fail(CONNECTOR_ERROR_CODES.OAUTH_SCOPE_UPGRADE_REQUIRED);
    }
    if (!FINANCIAL_WRITES_ENABLED) {
      return fail(CONNECTOR_ERROR_CODES.FINANCIAL_WRITES_DISABLED);
    }
  }

  if (contract.riskClass !== "low_risk" && !FINANCIAL_WRITES_ENABLED) {
    return fail(CONNECTOR_ERROR_CODES.FINANCIAL_WRITES_DISABLED);
  }

  return {
    ok: true,
    instanceId: fresh.id,
    mcpToolName: contract.mcpToolName,
    connected: true,
    scopeTier,
    writesEnabled: FINANCIAL_WRITES_ENABLED,
  };
}

function fail(code: (typeof CONNECTOR_ERROR_CODES)[keyof typeof CONNECTOR_ERROR_CODES]) {
  return {
    ok: false as const,
    status: 409 as const,
    body: customerConnectorError(code),
    inventsData: false as const,
    code,
  };
}

export function xeroMcpUnavailableResponse() {
  return {
    ...customerConnectorError(CONNECTOR_ERROR_CODES.XERO_MCP_UNAVAILABLE),
    inventsData: false,
    dataPlane: [
      "Xero",
      "Company Business MCP",
      "INFRA control plane",
      "AI client",
    ],
  };
}

export function instanceHasWriteScopes(scopes: string[]): boolean {
  const set = new Set(scopes);
  return XERO_WRITE_SCOPES.some((scope) => set.has(scope));
}
