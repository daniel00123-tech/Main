/**
 * Authoritative permission evaluation for Action Engine.
 *
 * Decision stack:
 *   PLATFORM SAFETY CEILING → TENANT FEATURE AVAILABILITY → ROLE PERMISSION
 *   → ACTION RISK REQUIREMENTS → APPROVAL / SEPARATION-OF-DUTIES → EXECUTION GATE
 */

import {
  betaGateForAction,
  isActionBetaEnabled,
  isActionProductionEnabled,
  isPlatformBlockedXeroAction,
  XERO_WRITE_PRODUCTION_GATES,
  type PermissionDecision as EnginePermissionDecision,
  type RiskClassification,
  type WriteFeatureFlags,
  DEFAULT_WRITE_FEATURE_FLAGS,
  xeroActionDefinition,
  actionRiskProfile,
} from "@infra/shared";
import type { CompanyRole, ToolAction } from "@infra/shared";
import {
  effectiveActionAllowed,
  listRoleActionOverrides,
} from "../../permissions/service";
import { evaluateActionPermission as evaluateEnginePermission } from "./permission-engine";

export type UnifiedDenialCode =
  | "PLATFORM_RESTRICTED"
  | "TENANT_DISABLED"
  | "ROLE_PERMISSION_DENIED"
  | "APPROVAL_REQUIRED"
  | "SELF_APPROVAL_DENIED"
  | "PRODUCTION_GATE_CLOSED"
  | "company_suspended"
  | "identity_disabled"
  | "connector_disconnected"
  | "scope_missing"
  | "destructive_disabled"
  | "writes_disabled"
  | "allowed";

export type UnifiedPermissionDecision = EnginePermissionDecision & {
  denialCode: UnifiedDenialCode;
  roleAllowed?: boolean;
  platformBlocked?: boolean;
  productionGateOpen?: boolean;
};

export async function evaluateUnifiedActionPermission(
  db: D1Database,
  input: {
    action: string;
    riskClass: RiskClassification;
    companyId: string;
    companyStatus: string;
    connectorConnected: boolean;
    connectorAuthStatus: string;
    grantedScopes?: string[];
    requiredScopes?: string[];
    identityStatus?: string;
    actorRole?: CompanyRole | string | null;
    actorType?: "service" | "user";
    actorEmail?: string;
    requesterEmail?: string | null;
    approverEmail?: string | null;
    flags?: Partial<WriteFeatureFlags>;
    skipRoleCheck?: boolean;
  },
): Promise<UnifiedPermissionDecision> {
  const action = input.action;
  const toolAction = action as ToolAction;

  if (isPlatformBlockedXeroAction(action)) {
    const engine = evaluateEnginePermission({
      action,
      riskClass: input.riskClass,
      companyStatus: input.companyStatus,
      connectorConnected: input.connectorConnected,
      connectorAuthStatus: input.connectorAuthStatus,
      grantedScopes: input.grantedScopes,
      requiredScopes: input.requiredScopes,
      identityStatus: input.identityStatus,
      actorRole: input.actorRole ?? undefined,
      actorType: input.actorType,
      flags: input.flags,
    });
    return {
      ...engine,
      allowed: false,
      denialCode: "PLATFORM_RESTRICTED",
      platformBlocked: true,
      reasonCode: "platform_restricted",
      message: "This action is restricted by platform safety policy.",
    };
  }

  const gate = betaGateForAction(action);
  const productionGateOpen = gate
    ? isActionProductionEnabled(gate, XERO_WRITE_PRODUCTION_GATES)
    : true;
  const betaGateOpen = gate
    ? isActionBetaEnabled(gate, XERO_WRITE_PRODUCTION_GATES)
    : true;

  if (gate && !betaGateOpen) {
    return {
      ...baseDecision(input),
      allowed: false,
      denialCode: "TENANT_DISABLED",
      productionGateOpen: false,
      reasonCode: "tenant_disabled",
      message: "This action is not enabled for this tenant.",
    };
  }

  if (gate && !productionGateOpen) {
    const engine = evaluateEnginePermission({
      action,
      riskClass: input.riskClass,
      companyStatus: input.companyStatus,
      connectorConnected: input.connectorConnected,
      connectorAuthStatus: input.connectorAuthStatus,
      grantedScopes: input.grantedScopes,
      requiredScopes: input.requiredScopes,
      identityStatus: input.identityStatus,
      actorRole: input.actorRole ?? undefined,
      actorType: input.actorType,
      flags: input.flags,
    });
    return {
      ...engine,
      allowed: false,
      denialCode: "PRODUCTION_GATE_CLOSED",
      productionGateOpen: false,
      reasonCode: "production_gate_closed",
      message: `Action ${action} is implemented but not production-enabled.`,
    };
  }

  let roleAllowed = true;
  if (!input.skipRoleCheck && input.actorRole && input.actorType === "user") {
    const overrides = await listRoleActionOverrides(db, input.companyId);
    roleAllowed = effectiveActionAllowed(
      input.actorRole as CompanyRole,
      toolAction,
      overrides,
    );
    if (!roleAllowed) {
      return {
        ...baseDecision(input),
        allowed: false,
        denialCode: "ROLE_PERMISSION_DENIED",
        roleAllowed: false,
        reasonCode: "role_permission_denied",
        message: "Your role does not permit this action.",
      };
    }
  }

  const engine = evaluateEnginePermission({
    action,
    riskClass: input.riskClass,
    companyStatus: input.companyStatus,
    connectorConnected: input.connectorConnected,
    connectorAuthStatus: input.connectorAuthStatus,
    grantedScopes: input.grantedScopes,
    requiredScopes: input.requiredScopes,
    identityStatus: input.identityStatus,
    actorRole: input.actorRole ?? undefined,
    actorType: input.actorType,
    flags: input.flags,
  });

  if (!engine.allowed) {
    return {
      ...engine,
      denialCode: mapEngineReason(engine.reasonCode),
      roleAllowed,
      productionGateOpen,
    };
  }

  if (
    input.requesterEmail &&
    input.approverEmail &&
    input.requesterEmail.toLowerCase() === input.approverEmail.toLowerCase()
  ) {
    const profile = actionRiskProfile(action);
    if (engine.requiresApproval || profile.requiresApproval || profile.level === "DESTRUCTIVE" || profile.level === "MONEY_MOVEMENT") {
      return {
        ...engine,
        allowed: false,
        denialCode: "SELF_APPROVAL_DENIED",
        reasonCode: "self_approval_denied",
        message: "You cannot approve your own action request.",
      };
    }
  }

  return {
    ...engine,
    denialCode: engine.requiresApproval
      ? "APPROVAL_REQUIRED"
      : engine.requiresConfirmation
        ? "APPROVAL_REQUIRED"
        : "allowed",
    roleAllowed,
    productionGateOpen,
  };
}

function baseDecision(input: {
  action: string;
  riskClass: RiskClassification;
  flags?: Partial<WriteFeatureFlags>;
}): EnginePermissionDecision {
  const flags = { ...DEFAULT_WRITE_FEATURE_FLAGS, ...input.flags };
  const def = xeroActionDefinition(input.action);
  const profile = actionRiskProfile(input.action);
  return {
    allowed: false,
    requiredPermission: input.action,
    riskClass: input.riskClass,
    writesSupported: flags.writesSupported,
    writesEnabled: flags.writesEnabled,
    financialWritesEnabled: flags.financialWritesEnabled,
    destructiveWritesEnabled: flags.destructiveWritesEnabled,
    requiresConfirmation: profile.requiresConfirmation,
    requiresApproval: profile.requiresApproval,
    reasonCode: "denied",
    message: undefined,
  };
}

function mapEngineReason(code?: string): UnifiedDenialCode {
  switch (code) {
    case "company_suspended":
      return "company_suspended";
    case "identity_disabled":
      return "identity_disabled";
    case "connector_disconnected":
      return "connector_disconnected";
    case "scope_missing":
      return "scope_missing";
    case "destructive_disabled":
      return "destructive_disabled";
    case "writes_disabled":
      return "writes_disabled";
    case "approval_required":
      return "APPROVAL_REQUIRED";
    default:
      return "TENANT_DISABLED";
  }
}
