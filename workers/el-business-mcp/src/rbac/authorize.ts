import {
  CONFIRMATION_REQUIRED_CAPABILITIES,
  SENSITIVE_CAPABILITIES,
  isElvexCapability,
  type ElvexCapability,
} from "./capabilities";
import { ELVEX_ROLE_DENIES, ELVEX_ROLE_GRANTS, isElvexRole } from "./roles";
import type { ElvexActor } from "./actor";
import { AuthorizationError } from "./errors";

export type ResourceContext = {
  mailbox?: string | null;
  classification?: string | null;
  xeroTool?: string | null;
  xeroReport?: string | null;
  path?: string | null;
  itemId?: string | null;
  driveId?: string | null;
  resource?: string | null;
};

export type AuthorizationDecision = {
  allowed: boolean;
  decision: "allow" | "deny";
  capability: ElvexCapability;
  role: string | null;
  actorId: string;
  principalType: string;
  identityBound: boolean;
  confirmationRequired: boolean;
  reason: string;
  resource: string | null;
  companyId: string;
};

/**
 * Central authorisation. Fail closed. Deny beats allow.
 * Never trust a caller-supplied role on the request body.
 */
export function can(
  actor: ElvexActor | null | undefined,
  capability: string,
  resourceContext: ResourceContext = {}
): AuthorizationDecision {
  const resource = describeResource(resourceContext);
  if (!isElvexCapability(capability)) {
    return deny(actor, capability as ElvexCapability, resource, "Unknown capability (fail closed)");
  }

  if (!actor || !actor.identityBound) {
    return deny(
      actor,
      capability,
      resource,
      "Authenticated company identity is required. Shared MCP tokens and AI prompts are not a security boundary."
    );
  }

  if (actor.principalType === "service") {
    const grants = new Set(actor.serviceCapabilities ?? []);
    if (!grants.has(capability)) {
      return deny(
        actor,
        capability,
        resource,
        "Service principal does not have this capability. Automations must use an explicit narrow grant, not Company Admin impersonation."
      );
    }
    return allow(actor, capability, resource);
  }

  if (!isElvexRole(actor.role)) {
    return deny(actor, capability, resource, "No Elvex company role assigned (fail closed)");
  }

  if (ELVEX_ROLE_DENIES[actor.role].has(capability)) {
    return deny(actor, capability, resource, "Explicit deny override");
  }

  if (!ELVEX_ROLE_GRANTS[actor.role].has(capability)) {
    return deny(actor, capability, resource, "Role preset does not grant this capability");
  }

  return allow(actor, capability, resource);
}

export function assertCan(
  actor: ElvexActor | null | undefined,
  capability: string,
  resourceContext: ResourceContext = {}
): AuthorizationDecision {
  const decision = can(actor, capability, resourceContext);
  if (!decision.allowed) {
    throw new AuthorizationError(
      decision.reason,
      "EL_RBAC_DENIED",
      403,
      decision.capability,
      decision.resource ?? undefined
    );
  }
  return decision;
}

export function isSensitiveCapability(capability: string): boolean {
  return isElvexCapability(capability) && SENSITIVE_CAPABILITIES.has(capability);
}

function allow(actor: ElvexActor, capability: ElvexCapability, resource: string | null): AuthorizationDecision {
  return {
    allowed: true,
    decision: "allow",
    capability,
    role: actor.role,
    actorId: actor.actorId,
    principalType: actor.principalType,
    identityBound: actor.identityBound,
    confirmationRequired: CONFIRMATION_REQUIRED_CAPABILITIES.has(capability),
    reason: "Explicit capability grant",
    resource,
    companyId: actor.companyId,
  };
}

function deny(
  actor: ElvexActor | null | undefined,
  capability: ElvexCapability,
  resource: string | null,
  reason: string
): AuthorizationDecision {
  return {
    allowed: false,
    decision: "deny",
    capability,
    role: actor?.role ?? null,
    actorId: actor?.actorId ?? "anonymous",
    principalType: actor?.principalType ?? "user",
    identityBound: Boolean(actor?.identityBound),
    confirmationRequired: false,
    reason,
    resource,
    companyId: actor?.companyId ?? "co_el",
  };
}

function describeResource(ctx: ResourceContext): string | null {
  return (
    ctx.resource ??
    ctx.mailbox ??
    ctx.xeroTool ??
    ctx.xeroReport ??
    ctx.itemId ??
    ctx.path ??
    ctx.classification ??
    null
  );
}
