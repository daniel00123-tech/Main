import {
  CONNECTOR_ERROR_CODES,
  XERO_WRITE_ACTIVATION,
  customerConnectorError,
} from "@infra/shared";
import { isFinancialRiskClass, isWriteRiskClass } from "./connector-lifecycle";

/**
 * Approval gate for connector actions including Xero financial writes.
 * Architecture supports writes (writesSupported) but production execution
 * remains blocked until FINANCIAL_WRITES_ENABLED is explicitly approved.
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

/** Explicit production gate — do not enable without operator approval. */
export const FINANCIAL_WRITES_ENABLED = false;
