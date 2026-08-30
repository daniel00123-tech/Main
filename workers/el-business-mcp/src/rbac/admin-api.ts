import { ELVEX_COMPANY_ID, ELVEX_COMPANY_NAME } from "./actor";
import { ELVEX_CAPABILITIES } from "./capabilities";
import {
  CLASSIFICATION_LABELS,
  DATA_CLASSIFICATIONS,
  isDataClassification,
} from "./classify";
import { capabilitiesForRole, ELVEX_ROLE_LABELS, ELVEX_ROLES, isElvexRole } from "./roles";
import { can } from "./authorize";
import { getRequestActor } from "./context";
import { recordPermissionAudit, listPermissionAudit } from "./audit";
import { verifyUserSync } from "./identity";
import {
  bindUserMicrosoftOid,
  getUserByEmail,
  getUserById,
  listClassifications,
  listCompanyUsers,
  updateUserRole,
  updateUserStatus,
  upsertClassification,
  upsertCompanyUser,
} from "./store";
import { isMicrosoftOid } from "../oauth/crypto";
import { DEFAULT_PROTECTED_USER_HINTS, publicMicrosoftPolicy, loadMicrosoftConfig } from "../microsoft/config";
import { xeroPublicStatus } from "../xero/verify";
import type { Env } from "../env";
import { AuthorizationError } from "./errors";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function requireAdminCapability(env: Env, capability: "admin.portal.access" | "admin.roles.manage" | "admin.users.manage" | "admin.config.manage") {
  const actor = getRequestActor();
  const decision = can(actor, capability, { resource: "admin" });
  await recordPermissionAudit(env.EL_BUSINESS_DATA, decision, {
    eventType: "admin.access",
    correlationId: actor.correlationId,
    force: true,
  });
  if (!decision.allowed) {
    throw new AuthorizationError(decision.reason, "EL_RBAC_DENIED", 403, capability, "admin");
  }
  return { actor, decision };
}

export async function handleRbacAdminRequest(
  request: Request,
  env: Env,
  url: URL
): Promise<Response | null> {
  if (!url.pathname.startsWith("/admin/rbac")) return null;

  try {
    if (url.pathname === "/admin/rbac/sync-user" && request.method === "POST") {
      const body = (await request.json()) as Record<string, unknown>;
      const verified = await verifyUserSync(env, body);
      if (!verified || !isElvexRole(verified.role)) {
        return json({ error: "Signed INFRA user sync is required. Caller-supplied roles are ignored." }, 403);
      }
      const user = await upsertCompanyUser(env.EL_BUSINESS_DATA, {
        externalId: verified.externalId,
        microsoftOid: verified.microsoftOid,
        email: verified.email,
        displayName: verified.displayName,
        role: verified.role,
        status: verified.status,
      });
      await recordPermissionAudit(
        env.EL_BUSINESS_DATA,
        {
          allowed: true,
          decision: "allow",
          capability: "admin.roles.manage",
          role: "company_admin",
          actorId: "infra_control_plane",
          principalType: "service",
          identityBound: true,
          confirmationRequired: true,
          reason: "INFRA signed membership sync",
          resource: user.id,
          companyId: ELVEX_COMPANY_ID,
        },
        { eventType: "role.changed", force: true }
      );
      return json({ ok: true, user, audit: "role.changed" });
    }

    if (url.pathname === "/admin/rbac" && request.method === "GET") {
      await requireAdminCapability(env, "admin.portal.access");
      return json(await buildRbacSnapshot(env));
    }

    if (url.pathname === "/admin/rbac/users" && request.method === "GET") {
      await requireAdminCapability(env, "admin.portal.access");
      return json({ company: ELVEX_COMPANY_NAME, users: await listCompanyUsers(env.EL_BUSINESS_DATA) });
    }

    if (url.pathname === "/admin/rbac/users" && request.method === "POST") {
      const { actor } = await requireAdminCapability(env, "admin.users.manage");
      const body = (await request.json()) as {
        email?: string;
        displayName?: string;
        role?: string;
        externalId?: string;
        microsoftOid?: string;
        status?: "active" | "disabled";
      };
      if (!body.email || !isElvexRole(body.role ?? "")) {
        return json({ error: "email and a canonical Elvex role are required" }, 400);
      }
      if (!can(actor, "admin.roles.manage").allowed) {
        return json({ error: "Only Company Admin may assign roles" }, 403);
      }
      if (body.microsoftOid && !isMicrosoftOid(body.microsoftOid)) {
        return json({ error: "microsoftOid must be a Microsoft Entra object ID (GUID)" }, 400);
      }
      const user = await upsertCompanyUser(env.EL_BUSINESS_DATA, {
        email: body.email,
        displayName: body.displayName,
        role: body.role as "engineer",
        externalId: body.externalId,
        microsoftOid: body.microsoftOid,
        status: body.status,
      });
      return json({ ok: true, user });
    }

    if (url.pathname === "/admin/rbac/users/bind-microsoft" && request.method === "POST") {
      await requireAdminCapability(env, "admin.users.manage");
      const body = (await request.json()) as {
        userId?: string;
        email?: string;
        microsoftOid?: string;
      };
      if (!isMicrosoftOid(body.microsoftOid ?? "")) {
        return json({ error: "microsoftOid must be a Microsoft Entra object ID (GUID)" }, 400);
      }
      const existing = body.userId
        ? await getUserById(env.EL_BUSINESS_DATA, body.userId)
        : body.email
          ? await getUserByEmail(env.EL_BUSINESS_DATA, body.email)
          : null;
      if (!existing) {
        return json({ error: "EL company user not found. Provision the user before binding Microsoft identity." }, 404);
      }
      try {
        const user = await bindUserMicrosoftOid(env.EL_BUSINESS_DATA, existing.id, body.microsoftOid!.trim());
        return json({ ok: true, user });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 409);
      }
    }

    if (url.pathname.startsWith("/admin/rbac/users/") && url.pathname.endsWith("/role") && request.method === "POST") {
      const { actor } = await requireAdminCapability(env, "admin.roles.manage");
      const userId = url.pathname.split("/")[4];
      const body = (await request.json()) as { role?: string };
      if (!isElvexRole(body.role ?? "")) {
        return json({ error: "Canonical Elvex role is required" }, 400);
      }
      if (userId === actor.actorId) {
        return json({ error: "A user cannot change their own role" }, 403);
      }
      const updated = await updateUserRole(env.EL_BUSINESS_DATA, userId, body.role as "engineer");
      const decision = can(actor, "admin.roles.manage", { resource: userId });
      await recordPermissionAudit(env.EL_BUSINESS_DATA, { ...decision, resource: userId }, {
        eventType: "role.changed",
        force: true,
        correlationId: actor.correlationId,
      });
      return json({ ok: true, user: updated, audit: "role.changed" });
    }

    if (url.pathname.startsWith("/admin/rbac/users/") && url.pathname.endsWith("/bind") && request.method === "POST") {
      await requireAdminCapability(env, "admin.users.manage");
      const userId = url.pathname.split("/")[4];
      const body = (await request.json()) as { microsoftOid?: string };
      if (!isMicrosoftOid(body.microsoftOid ?? "")) {
        return json({ error: "microsoftOid must be a Microsoft Entra object ID (GUID)" }, 400);
      }
      try {
        const user = await bindUserMicrosoftOid(env.EL_BUSINESS_DATA, userId, body.microsoftOid!.trim());
        return json({ ok: true, user });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 409);
      }
    }

    if (url.pathname.startsWith("/admin/rbac/users/") && url.pathname.endsWith("/status") && request.method === "POST") {
      await requireAdminCapability(env, "admin.users.manage");
      const userId = url.pathname.split("/")[4];
      const body = (await request.json()) as { status?: string };
      if (body.status !== "active" && body.status !== "disabled") {
        return json({ error: "status must be active or disabled" }, 400);
      }
      const updated = await updateUserStatus(env.EL_BUSINESS_DATA, userId, body.status);
      return json({ ok: true, user: updated });
    }

    if (url.pathname === "/admin/rbac/classifications" && request.method === "GET") {
      await requireAdminCapability(env, "admin.portal.access");
      return json({
        classifications: DATA_CLASSIFICATIONS.map((id) => ({ id, label: CLASSIFICATION_LABELS[id] })),
        items: await listClassifications(env.EL_BUSINESS_DATA),
      });
    }

    if (url.pathname === "/admin/rbac/classifications" && request.method === "POST") {
      const { actor } = await requireAdminCapability(env, "admin.config.manage");
      const body = (await request.json()) as {
        itemKey?: string;
        classification?: string;
        source?: "explicit" | "directory";
        pathPattern?: string;
      };
      if (!body.itemKey || !isDataClassification(body.classification ?? "")) {
        return json({ error: "itemKey and a valid classification are required" }, 400);
      }
      await upsertClassification(env.EL_BUSINESS_DATA, {
        itemKey: body.itemKey,
        classification: body.classification as "company_general",
        source: body.source === "directory" ? "directory" : "explicit",
        pathPattern: body.pathPattern,
        updatedBy: actor.actorId,
      });
      const decision = can(actor, "admin.config.manage", { resource: body.itemKey });
      await recordPermissionAudit(env.EL_BUSINESS_DATA, decision, {
        eventType: "classification.changed",
        force: true,
      });
      return json({ ok: true });
    }

    if (url.pathname === "/admin/rbac/audit" && request.method === "GET") {
      await requireAdminCapability(env, "admin.portal.access");
      return json({ events: await listPermissionAudit(env.EL_BUSINESS_DATA) });
    }

    return json({ error: "Not Found" }, 404);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return json({ error: error.message, code: error.code, capability: error.capability }, error.status);
    }
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

export async function buildRbacSnapshot(env: Env): Promise<Record<string, unknown>> {
  const actor = getRequestActor();
  return {
    company: ELVEX_COMPANY_NAME,
    companyId: ELVEX_COMPANY_ID,
    identity: {
      bound: actor.identityBound,
      limitation: actor.identityBound
        ? null
        : "Employee ChatGPT access uses INFRA authentication. Privileged tools require an active INFRA company membership. Role is resolved live from INFRA and is never taken from the MCP token. The shared MCP bearer token is machine/service transport only and never grants a human Company Admin role.",
    },
    roles: ELVEX_ROLES.map((role) => ({
      role,
      label: ELVEX_ROLE_LABELS[role],
      capabilities: capabilitiesForRole(role).map((capability) => ({
        capability,
        access: capability.includes(".write") || capability.endsWith(".manage") ? "write" : "read",
      })),
    })),
    capabilities: ELVEX_CAPABILITIES,
    classifications: DATA_CLASSIFICATIONS.map((id) => ({ id, label: CLASSIFICATION_LABELS[id] })),
    protectedMicrosoftUsers: {
      hints: DEFAULT_PROTECTED_USER_HINTS,
      policy: publicMicrosoftPolicy(loadMicrosoftConfig(env)),
    },
    connectors: {
      microsoft: publicMicrosoftPolicy(loadMicrosoftConfig(env)),
      xero: await xeroPublicStatus(env),
    },
    users: await listCompanyUsers(env.EL_BUSINESS_DATA).catch(() => []),
  };
}
