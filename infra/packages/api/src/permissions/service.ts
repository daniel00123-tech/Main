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

  const membership = user.memberships.find((m) => m.companyId === companyId);
  const customRoleId = membership?.customRoleId;
  if (customRoleId) {
    const grants = await db
      .prepare(`SELECT action, effect FROM company_custom_role_grants WHERE custom_role_id = ?`)
      .bind(customRoleId)
      .all();
    const grant = (grants.results ?? []).find((g) => String(g.action) === action);
    if (grant?.effect === "deny") {
      return {
        allowed: false,
        action,
        companyId,
        role,
        riskClass,
        reason: "Custom role denies this action",
      };
    }
    if (grant?.effect === "allow") {
      return { allowed: true, action, companyId, role, riskClass };
    }
    return {
      allowed: false,
      action,
      companyId,
      role,
      riskClass,
      reason: "Custom role does not include this action",
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

const ALL_TOOL_ACTIONS = Object.keys(TOOL_ACTION_RISK) as ToolAction[];

/** Roles whose preset permissions cannot be overridden (prevents admin lockout). */
const PROTECTED_ROLES: CompanyRole[] = ["company_admin"];

export function isRolePermissionEditable(role: CompanyRole): boolean {
  return !PROTECTED_ROLES.includes(role);
}

export function effectiveActionAllowed(
  role: CompanyRole,
  action: ToolAction,
  overrides: Array<{ role: CompanyRole; action: ToolAction; effect: "allow" | "deny" }>,
): boolean {
  const override = overrides.find((item) => item.role === role && item.action === action);
  if (override?.effect === "deny") return false;
  if (override?.effect === "allow") return true;
  return isActionAllowed(role, action);
}

export async function replaceCompanyRoleOverrides(
  db: D1Database,
  companyId: string,
  role: CompanyRole,
  grants: Array<{ action: ToolAction; effect: "allow" | "deny" }>,
): Promise<Array<{ role: CompanyRole; action: ToolAction; effect: "allow" | "deny" }>> {
  if (!isRolePermissionEditable(role)) {
    throw new Error("This role cannot be modified");
  }

  const preset = COMPANY_ROLE_PRESETS.find((item) => item.role === role);
  if (!preset) throw new Error("Unknown role");

  const normalized: Array<{ action: ToolAction; effect: "allow" | "deny" }> = [];
  for (const grant of grants) {
    if (!ALL_TOOL_ACTIONS.includes(grant.action)) {
      throw new Error(`Unknown action: ${grant.action}`);
    }
    const presetAllowed = isActionAllowed(role, grant.action);
    const differs =
      (grant.effect === "allow" && !presetAllowed) ||
      (grant.effect === "deny" && presetAllowed);
    if (differs) normalized.push(grant);
  }

  const now = new Date().toISOString();
  await db
    .prepare(`DELETE FROM role_action_grants WHERE company_id = ? AND role = ?`)
    .bind(companyId, role)
    .run();

  for (const grant of normalized) {
    await db
      .prepare(
        `INSERT INTO role_action_grants (id, company_id, role, action, effect, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        companyId,
        role,
        grant.action,
        grant.effect,
        now,
        now,
      )
      .run();
  }

  return listRoleActionOverrides(db, companyId);
}
