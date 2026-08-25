import { CONNECTOR_ERROR_CODES, customerConnectorError } from "@infra/shared";
import { isFinancialRiskClass, isWriteRiskClass } from "./connector-lifecycle";

/**
 * Future approval hook. Financial writes stay blocked.
 * Connector execution must pass through identity → tenant → permission →
 * this classification → Business MCP. Do not bypass the gateway.
 */
export function evaluateApprovalRequirement(input: {
  riskClass: string;
  action: string;
  companyStatus: string;
}): {
  allowed: boolean;
  requiresApproval: boolean;
  error?: ReturnType<typeof customerConnectorError>;
} {
  if (input.companyStatus === "suspended") {
    return {
      allowed: false,
      requiresApproval: false,
      error: customerConnectorError(CONNECTOR_ERROR_CODES.SUSPENDED),
    };
  }

  const requiresApproval = isWriteRiskClass(input.riskClass);
  if (isFinancialRiskClass(input.riskClass)) {
    return {
      allowed: false,
      requiresApproval: true,
      error: customerConnectorError(CONNECTOR_ERROR_CODES.FINANCIAL_WRITES_DISABLED),
    };
  }

  return { allowed: true, requiresApproval };
}

export const FINANCIAL_WRITES_ENABLED = false;
