import {
  CONNECTOR_ERROR_CODES,
  XERO_READ_MCP_TOOLS,
  XERO_TOOL_CONTRACTS,
  customerConnectorError,
} from "@infra/shared";
import type { Env } from "../env";
import { getConnectorInstance, listConnectorInstances } from "./control-plane";

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

export function xeroReadToolContracts() {
  return XERO_TOOL_CONTRACTS.filter(
    (tool) => tool.implemented && tool.riskClass === "low_risk",
  );
}

export function expectedXeroMcpTools(): string[] {
  return [...XERO_READ_MCP_TOOLS];
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
} | null {
  const contract = xeroToolContract(toolName);
  if (!contract) return null;
  return { action: contract.action, riskClass: contract.riskClass };
}

/**
 * Company MCP owns live Xero accounting reads. INFRA only confirms the
 * connector is connected and that the requested tool is a read contract.
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
    }
  | {
      ok: false;
      status: 409;
      body: ReturnType<typeof customerConnectorError>;
      inventsData: false;
    }
> {
  const contract = XERO_TOOL_CONTRACTS.find(
    (tool) => tool.mcpToolName === input.toolName || tool.name === input.toolName,
  );
  if (!contract || !contract.implemented || contract.riskClass !== "low_risk") {
    return {
      ok: false,
      status: 409,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.FINANCIAL_WRITES_DISABLED),
      inventsData: false,
    };
  }

  const instances = await listConnectorInstances(input.env.DB, input.companyId);
  const instance =
    instances.find(
      (row) =>
        row.connectorDefinitionId === "conn_xero" &&
        row.authStatus === "connected" &&
        Boolean(row.externalAccountId),
    ) ?? null;
  if (!instance) {
    return {
      ok: false,
      status: 409,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.CONNECTOR_NOT_CONNECTED),
      inventsData: false,
    };
  }

  const fresh = await getConnectorInstance(input.env.DB, instance.id);
  if (!fresh || fresh.companyId !== input.companyId) {
    return {
      ok: false,
      status: 409,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.CREDENTIAL_REF_FORBIDDEN),
      inventsData: false,
    };
  }

  return {
    ok: true,
    instanceId: fresh.id,
    mcpToolName: contract.mcpToolName,
    connected: true,
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
