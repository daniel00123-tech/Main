/**
 * Automation Engine permission helpers — reuses INFRA company isolation.
 */

import type { SessionUser } from "../../auth/session";
import { getUserCompanyRole, userHasCompanyAccess } from "../../permissions/service";
import {
  createServiceIdentity,
  getServiceIdentity,
  type ServiceIdentityRecord,
} from "../service-identities";
import type { AutomationDefinitionRecord } from "@infra/shared";
import type { GatewayActor } from "../gateway";

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

function serviceCanAdministerAutomations(identity: ServiceIdentityRecord, companyId: string): boolean {
  if (identity.companyId !== companyId) return false;
  if (identity.status !== "active") return false;
  if (identity.identityType === "automation" || identity.identityType === "scheduled") {
    return false;
  }
  return true;
}

export function canViewAutomationsAsActor(actor: GatewayActor, companyId: string): boolean {
  if (actor.type === "user") return canViewAutomations(actor.user, companyId);
  return serviceCanAdministerAutomations(actor.identity, companyId);
}

export function canManageAutomationsAsActor(actor: GatewayActor, companyId: string): boolean {
  if (actor.type === "user") return canManageAutomations(actor.user, companyId);
  return serviceCanAdministerAutomations(actor.identity, companyId);
}

export function automationActorLabel(actor: GatewayActor): string {
  if (actor.type === "user") return actor.user.email;
  return `${actor.identity.identityType}:${actor.identity.name}`;
}

export function automationActorSource(
  actor: GatewayActor,
): "chatgpt" | "portal" | "platform_admin" | "api" {
  if (actor.type === "user") {
    return actor.user.isPlatformAdmin ? "platform_admin" : "portal";
  }
  if (actor.identity.identityType === "chatgpt") return "chatgpt";
  return "api";
}
