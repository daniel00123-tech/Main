import {
  COMPANY_ROLE_PRESETS,
  TOOL_ACTION_RISK,
  isActionAllowed,
  type CompanyRole,
  type ToolAction,
} from "@infra/shared";
import type { SessionUser } from "../auth/session";

export interface PermissionDecision {
  allowed: boolean;
  action: ToolAction;
  companyId: string;
  role: CompanyRole | null;
  riskClass: string;
  reason?: string;
}

export function userHasCompanyAccess(
  user: SessionUser,
  companyId: string,
): boolean {
  if (user.isPlatformAdmin) return true;
  return user.memberships.some(
    (membership) => membership.companyId === companyId,
  );
}

export function getUserCompanyRole(
  user: SessionUser,
  companyId: string,
): CompanyRole | null {
  if (user.isPlatformAdmin) return "company_admin";
  const membership = user.memberships.find(
    (item) => item.companyId === companyId,
  );
  return membership?.role ?? null;
}

export async function listRoleActionOverrides(
  db: D1Database,
  companyId: string,
): Promise<Array<{ role: CompanyRole; action: ToolAction; effect: "allow" | "deny" }>> {
  const result = await db
    .prepare(
      "SELECT role, action, effect FROM role_action_grants WHERE company_id = ?",
    )
    .bind(companyId)
    .all();

  return (result.results ?? []).map((row) => ({
    role: String(row.role) as CompanyRole,
    action: String(row.action) as ToolAction,
    effect: String(row.effect) as "allow" | "deny",
  }));
}

export function resolvePresetPermissions(role: CompanyRole): ToolAction[] {
  const preset = COMPANY_ROLE_PRESETS.find((item) => item.role === role);
  return preset?.allowedActions ?? [];
}

export async function evaluateActionPermission(
  db: D1Database,
  user: SessionUser,
  companyId: string,
  action: ToolAction,
): Promise<PermissionDecision> {
  const role = getUserCompanyRole(user, companyId);
  const riskClass = TOOL_ACTION_RISK[action]?.riskClass ?? "high_risk";

  if (!userHasCompanyAccess(user, companyId)) {
    return {
      allowed: false,
      action,
      companyId,
      role,
      riskClass,
      reason: "User is not a member of this company",
    };
  }

  if (!role) {
    return {
      allowed: false,
      action,
      companyId,
      role: null,
      riskClass,
      reason: "No company role assigned",
    };
  }

  const overrides = await listRoleActionOverrides(db, companyId);
  const override = overrides.find(
    (item) => item.role === role && item.action === action,
  );

  if (override?.effect === "deny") {
    return {
      allowed: false,
      action,
      companyId,
      role,
      riskClass,
      reason: "Explicit company deny override",
    };
  }

  if (override?.effect === "allow") {
    return {
      allowed: true,
      action,
      companyId,
      role,
      riskClass,
    };
  }

  const allowed = isActionAllowed(role, action);
  return {
    allowed,
    action,
    companyId,
    role,
    riskClass,
    reason: allowed ? undefined : "Role preset does not allow this action",
  };
}

export function listRolePresets() {
  return COMPANY_ROLE_PRESETS.map((preset) => ({
    role: preset.role,
    displayName: preset.displayName,
    description: preset.description,
    allowedActions: preset.allowedActions,
    deniedByDefault: preset.deniedByDefault,
  }));
}
