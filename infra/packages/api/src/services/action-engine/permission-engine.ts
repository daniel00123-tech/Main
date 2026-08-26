import {
  CONNECTOR_ERROR_CODES,
  customerConnectorError,
  type PermissionDecision,
  type RiskClassification,
  type WriteFeatureFlags,
  DEFAULT_WRITE_FEATURE_FLAGS,
  xeroActionDefinition,
} from "@infra/shared";
import { isFinancialRiskClass, isWriteRiskClass } from "../connector-lifecycle";

export type PermissionEvaluationInput = {
  action: string;
  riskClass: RiskClassification;
  companyStatus: string;
  connectorConnected: boolean;
  connectorAuthStatus: string;
  grantedScopes?: string[];
  requiredScopes?: string[];
  identityStatus?: string;
  /** When director/company_admin, separate organisational approval is not required for confirmation-only flows. */
  actorRole?: string;
  flags?: Partial<WriteFeatureFlags>;
};

const DIRECTOR_ROLES = new Set(["director", "company_admin"]);

/** Draft ACCREC invoices are created in DRAFT status only — ChatGPT confirmation is sufficient. */
function isDraftInvoiceCreateAction(action: string): boolean {
  return action === "xero.invoices.create";
}

function separateApprovalRequired(input: {
  action: string;
  isFinancial: boolean;
  riskClass: RiskClassification;
  actorRole?: string;
}): boolean {
  if (isDraftInvoiceCreateAction(input.action)) return false;
  if (!input.isFinancial && input.riskClass !== "delete") return false;
  if (input.riskClass === "delete") return true;
  if (input.actorRole && DIRECTOR_ROLES.has(input.actorRole)) return false;
  return true;
}

export function evaluateActionPermission(
  input: PermissionEvaluationInput,
): PermissionDecision {
  const flags = { ...DEFAULT_WRITE_FEATURE_FLAGS, ...input.flags };
  const def = xeroActionDefinition(input.action);
  const requiredPermission = input.action;
  const riskClass = input.riskClass;

  const base = {
    requiredPermission,
    riskClass,
    writesSupported: flags.writesSupported,
    writesEnabled: flags.writesEnabled,
    financialWritesEnabled: flags.financialWritesEnabled,
    destructiveWritesEnabled: flags.destructiveWritesEnabled,
    requiresConfirmation: false,
    requiresApproval: false,
  };

  if (input.companyStatus === "suspended") {
    return {
      ...base,
      allowed: false,
      reasonCode: "company_suspended",
      message: customerConnectorError(CONNECTOR_ERROR_CODES.SUSPENDED).error,
    };
  }

  if (input.identityStatus === "disabled") {
    return {
      ...base,
      allowed: false,
      reasonCode: "identity_disabled",
      message: "Service identity is disabled",
    };
  }

  if (!input.connectorConnected || input.connectorAuthStatus !== "connected") {
    return {
      ...base,
      allowed: false,
      reasonCode: "connector_disconnected",
      message: customerConnectorError(CONNECTOR_ERROR_CODES.CONNECTOR_NOT_CONNECTED).error,
    };
  }

  if (input.requiredScopes?.length) {
    const granted = new Set(input.grantedScopes ?? []);
    const missing = input.requiredScopes.filter((scope) => !granted.has(scope));
    if (missing.length > 0) {
      return {
        ...base,
        allowed: false,
        reasonCode: "scope_missing",
        message: customerConnectorError(CONNECTOR_ERROR_CODES.OAUTH_SCOPE_UPGRADE_REQUIRED).error,
      };
    }
  }

  if (riskClass === "delete" || def?.riskClass === "delete") {
    if (!flags.destructiveWritesEnabled) {
      return {
        ...base,
        allowed: false,
        reasonCode: "destructive_disabled",
        requiresApproval: true,
        message: customerConnectorError(CONNECTOR_ERROR_CODES.FINANCIAL_WRITES_DISABLED).error,
      };
    }
  }

  const isFinancial =
    isFinancialRiskClass(riskClass) || isFinancialRiskClass(def?.riskClass ?? "");
  const isWrite = isWriteRiskClass(riskClass) || isWriteRiskClass(def?.riskClass ?? "");

  if (isFinancial || isWrite || riskClass === "delete") {
    if (!flags.financialWritesEnabled && !flags.writesEnabled) {
      const needsSeparateApproval = separateApprovalRequired({
        action: input.action,
        isFinancial,
        riskClass,
        actorRole: input.actorRole,
      });
      return {
        ...base,
        allowed: false,
        reasonCode: "writes_disabled",
        requiresConfirmation: true,
        requiresApproval: needsSeparateApproval,
        message: customerConnectorError(CONNECTOR_ERROR_CODES.FINANCIAL_WRITES_DISABLED).error,
      };
    }
  }

  const requiresApproval = separateApprovalRequired({
    action: input.action,
    isFinancial,
    riskClass,
    actorRole: input.actorRole,
  });
  const requiresConfirmation = isFinancial || isWrite;

  return {
    ...base,
    allowed: true,
    reasonCode: requiresApproval ? "approval_required" : requiresConfirmation ? "confirmation_required" : "allowed",
    requiresConfirmation,
    requiresApproval,
    message: requiresApproval
      ? "Separate organisational approval required before execution."
      : requiresConfirmation
        ? "User confirmation required before execution."
        : undefined,
  };
}
