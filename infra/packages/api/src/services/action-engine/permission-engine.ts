import {
  CONNECTOR_ERROR_CODES,
  customerConnectorError,
  type PermissionDecision,
  type RiskClassification,
  type WriteFeatureFlags,
  DEFAULT_WRITE_FEATURE_FLAGS,
  xeroActionDefinition,
  actionRiskProfile,
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
  /** MCP service identities use confirmation-only for accounting commitment; portal users may need approval. */
  actorType?: "service" | "user";
  flags?: Partial<WriteFeatureFlags>;
};

const DIRECTOR_ROLES = new Set(["director", "company_admin"]);

function separateApprovalRequired(input: {
  action: string;
  actorRole?: string;
  actorType?: "service" | "user";
}): boolean {
  const profile = actionRiskProfile(input.action);
  if (!profile.requiresApproval) return false;

  // ChatGPT / MCP service identities: enhanced confirmation only (no portal loop).
  if (input.actorType === "service") {
    return profile.level === "MONEY_MOVEMENT" || profile.level === "DESTRUCTIVE";
  }

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
  const profile = actionRiskProfile(input.action);

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
        actorRole: input.actorRole,
        actorType: input.actorType,
      });
      return {
        ...base,
        allowed: false,
        reasonCode: "writes_disabled",
        requiresConfirmation: profile.requiresConfirmation,
        requiresApproval: needsSeparateApproval,
        message: customerConnectorError(CONNECTOR_ERROR_CODES.FINANCIAL_WRITES_DISABLED).error,
      };
    }
  }

  const requiresApproval = separateApprovalRequired({
    action: input.action,
    actorRole: input.actorRole,
    actorType: input.actorType,
  });
  const requiresConfirmation =
    profile.requiresConfirmation || isFinancial || isWrite;

  return {
    ...base,
    allowed: true,
    reasonCode: requiresApproval ? "approval_required" : requiresConfirmation ? "confirmation_required" : "allowed",
    requiresConfirmation,
    requiresApproval,
    message: requiresApproval
      ? "Separate organisational approval required before execution."
      : requiresConfirmation
        ? profile.requiresEnhancedConfirmation
          ? "Enhanced user confirmation required before execution."
          : "User confirmation required before execution."
        : undefined,
  };
}
