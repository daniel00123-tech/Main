import {
  CONNECTOR_ERROR_CODES,
  XERO_WRITE_ACTIVATION,
  customerConnectorError,
} from "@infra/shared";
import { isFinancialRiskClass, isWriteRiskClass } from "./connector-lifecycle";

/**
 * Action Engine execution gate — when true, approved action plans may execute via the controlled path.
 * Direct MCP/gateway Xero write tools remain blocked unconditionally in gateway.ts (ACTION_ENGINE_REQUIRED).
 */
export function evaluateApprovalRequirement(input: {
  riskClass: string;
  action: string;
  companyStatus: string;
}): {
  allowed: boolean;
  requiresApproval: boolean;
  writesSupported: boolean;
  writesEnabled: boolean;
  error?: ReturnType<typeof customerConnectorError>;
} {
  const writesSupported = XERO_WRITE_ACTIVATION.writesSupported;
  const writesEnabled = FINANCIAL_WRITES_ENABLED;

  if (input.companyStatus === "suspended") {
    return {
      allowed: false,
      requiresApproval: false,
      writesSupported,
      writesEnabled,
      error: customerConnectorError(CONNECTOR_ERROR_CODES.SUSPENDED),
    };
  }

  const requiresApproval =
    isWriteRiskClass(input.riskClass) || isFinancialRiskClass(input.riskClass);

  if (isFinancialRiskClass(input.riskClass) || input.riskClass === "delete") {
    if (!writesEnabled) {
      return {
        allowed: false,
        requiresApproval: true,
        writesSupported,
        writesEnabled,
        error: customerConnectorError(CONNECTOR_ERROR_CODES.FINANCIAL_WRITES_DISABLED),
      };
    }
  }

  if (input.riskClass === "write" && !writesEnabled) {
    return {
      allowed: false,
      requiresApproval: true,
      writesSupported,
      writesEnabled,
      error: customerConnectorError(CONNECTOR_ERROR_CODES.FINANCIAL_WRITES_DISABLED),
    };
  }

  return {
    allowed: true,
    requiresApproval,
    writesSupported,
    writesEnabled,
  };
}

/**
 * Enables Action Engine financial execution after plan approval + preflight.
 * Does NOT expose direct xero_create_* tools — those are rejected at the gateway layer.
 */
export const FINANCIAL_WRITES_ENABLED = true;

/** Documented invariant: gateway always returns ACTION_ENGINE_REQUIRED for direct write tools. */
export const DIRECT_MCP_FINANCIAL_WRITES_BLOCKED = true;
