/**
 * Automation Engine permission helpers — reuses INFRA company isolation.
 */

import type { SessionUser } from "../../auth/session";
import { getUserCompanyRole, userHasCompanyAccess } from "../../permissions/service";
import { createServiceIdentity, getServiceIdentity } from "../service-identities";
import type { AutomationDefinitionRecord } from "@infra/shared";

export function canManageAutomations(user: SessionUser, companyId: string): boolean {
  if (user.isPlatformAdmin) return true;
  if (!userHasCompanyAccess(user, companyId)) return false;
  const role = getUserCompanyRole(user, companyId);
  return role === "company_admin" || role === "director";
}

export function canViewAutomations(user: SessionUser, companyId: string): boolean {
  if (user.isPlatformAdmin) return true;
  if (!userHasCompanyAccess(user, companyId)) return false;
  const role = getUserCompanyRole(user, companyId);
  return (
    role === "company_admin" ||
    role === "director" ||
    role === "manager" ||
    role === "supervisor"
  );
}

export async function ensureAutomationServiceIdentity(
  db: D1Database,
  automation: AutomationDefinitionRecord,
): Promise<string> {
  if (automation.serviceIdentityId) {
    const existing = await getServiceIdentity(db, automation.serviceIdentityId);
    if (existing && existing.companyId === automation.companyId && existing.status === "active") {
      return existing.id;
    }
  }

  const { identity } = await createServiceIdentity(db, {
    companyId: automation.companyId,
    name: `Automation: ${automation.name}`.slice(0, 120),
    description: `Service identity for automation ${automation.id}`,
    identityType: "automation",
  });
  return identity.id;
}

export function assertAutomationTenant(
  automation: AutomationDefinitionRecord,
  companyId: string,
): void {
  if (automation.companyId !== companyId) {
    throw new Error("Automation does not belong to company");
  }
}
