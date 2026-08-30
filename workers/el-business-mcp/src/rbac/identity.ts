import type { Env } from "../env";
import { ELVEX_COMPANY_ID, unboundActor, type ElvexActor, type PrincipalType } from "./actor";
import { tokenCompanyIsElvex, verifyMcpAccessToken } from "../oauth/jwt";
import { isMicrosoftOid } from "../oauth/crypto";
import { introspectInfraMcpToken } from "../infra/introspect";

export { unboundActor };
import { isElvexRole, type ElvexRole } from "./roles";
import { getServicePrincipal, getUserByExternalId, getUserByEmail, getUserByMicrosoftOid, upsertCompanyUser } from "./store";

const IDENTITY_MAX_AGE_MS = 5 * 60 * 1000;

export const IDENTITY_HEADER = {
  actorId: "x-elvex-actor-id",
  email: "x-elvex-actor-email",
  displayName: "x-elvex-actor-name",
  principalType: "x-elvex-principal-type",
  timestamp: "x-elvex-identity-ts",
  correlationId: "x-elvex-correlation-id",
  signature: "x-elvex-identity-sig",
} as const;

/**
 * Caller-supplied role fields are ignored. Role always comes from D1
 * (or an explicit injected test actor).
 */
export function extractUntrustedRole(input: Record<string, unknown> | null | undefined): string | null {
  if (!input) return null;
  const raw = input.role ?? input.actor_role ?? input.company_role ?? input.elvex_role;
  return typeof raw === "string" ? raw : null;
}

export async function resolveActor(env: Env, request: Request | null): Promise<ElvexActor> {
  const correlationId =
    request?.headers.get(IDENTITY_HEADER.correlationId) ??
    request?.headers.get("x-correlation-id") ??
    null;

  if (!request) return unboundActor(correlationId);

  const bearer = extractBearer(request);
  if (bearer) {
    const mcp = await verifyMcpAccessToken(env, bearer);
    if (mcp) {
      return resolveInfraOAuthActor(env, mcp, { correlationId, token: bearer });
    }
  }

  const verified = await verifySignedIdentity(env, request);
  if (verified) {
    if (verified.principalType === "service") {
      const principal = env.EL_BUSINESS_DATA
        ? await getServicePrincipal(env.EL_BUSINESS_DATA, verified.actorId)
        : null;
      if (!principal || principal.status !== "active") {
        return unboundActor(correlationId);
      }
      return {
        principalType: "service",
        actorId: principal.id,
        email: principal.email,
        displayName: principal.displayName,
        role: null,
        serviceCapabilities: principal.capabilities,
        identityBound: true,
        identitySource: "d1",
        companyId: ELVEX_COMPANY_ID,
        correlationId: verified.correlationId,
      };
    }

    const db = env.EL_BUSINESS_DATA;
    if (!db) return unboundActor(correlationId);

    const byExternal = await getUserByExternalId(db, verified.actorId);
    const byEmail = verified.email ? await getUserByEmail(db, verified.email) : null;
    const user = byExternal ?? byEmail;
    if (!user || user.status !== "active" || !isElvexRole(user.role)) {
      return unboundActor(verified.correlationId, {
        email: verified.email || null,
        identitySource: "signed_infra",
      });
    }

    return {
      principalType: "user",
      actorId: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      identityBound: true,
      identitySource: "d1",
      companyId: ELVEX_COMPANY_ID,
      correlationId: verified.correlationId,
      microsoftOid: user.microsoftOid,
    };
  }

  if (bearer && env.MCP_AUTH_TOKEN?.trim() && bearer === env.MCP_AUTH_TOKEN.trim()) {
    return unboundActor(correlationId, {
      actorId: "service_token",
      identitySource: "service_token",
    });
  }

  return unboundActor(correlationId);
}

/**
 * ChatGPT / employee path: INFRA user id + company from the access token.
 * Role is never taken from the token. Live membership comes from INFRA
 * introspect when configured, otherwise from D1 company_users.external_id.
 */
export async function resolveInfraOAuthActor(
  env: Env,
  claims: {
    sub: string;
    company_id: string;
    company_slug: string;
    email?: string;
    name?: string;
    client?: string;
  },
  meta: { correlationId?: string | null; token?: string | null } = {}
): Promise<ElvexActor> {
  const correlationId = meta.correlationId ?? null;
  if (!tokenCompanyIsElvex({
    company_id: claims.company_id,
    company_slug: claims.company_slug,
  })) {
    return unboundActor(correlationId, {
      identitySource: "infra_oauth",
      email: claims.email ?? null,
      displayName: claims.name ?? null,
      actorId: claims.sub,
    });
  }

  const live = await introspectInfraMcpToken(env, {
    token: meta.token,
    userId: claims.sub,
    companyId: claims.company_id,
  });
  if (live && live.active === false) {
    return unboundActor(correlationId, {
      identitySource: "infra_oauth",
      actorId: claims.sub,
      email: claims.email ?? null,
      displayName: claims.name ?? null,
    });
  }

  if (!env.EL_BUSINESS_DATA) {
    return unboundActor(correlationId, { identitySource: "infra_oauth", actorId: claims.sub });
  }

  let user = await getUserByExternalId(env.EL_BUSINESS_DATA, claims.sub);
  if (live?.active && live.role && isElvexRole(live.role) && user) {
    if (user.role !== live.role || user.status !== "active") {
      user = await upsertCompanyUser(env.EL_BUSINESS_DATA, {
        externalId: claims.sub,
        email: live.email || user.email,
        displayName: live.display_name || user.displayName,
        role: live.role,
        status: "active",
      });
    }
  }

  if (!user || user.status !== "active" || !isElvexRole(user.role)) {
    return unboundActor(correlationId, {
      actorId: user?.id ?? claims.sub,
      identitySource: "infra_oauth",
      email: user?.email ?? claims.email ?? null,
      displayName: user?.displayName ?? claims.name ?? null,
    });
  }

  return {
    principalType: "user",
    actorId: user.externalId ?? user.id,
    email: user.email,
    displayName: user.displayName,
    role: live?.role && isElvexRole(live.role) ? live.role : user.role,
    identityBound: true,
    identitySource: "infra_oauth",
    companyId: ELVEX_COMPANY_ID,
    correlationId,
    microsoftOid: user.microsoftOid,
  };
}

/**
 * Legacy helper retained for Microsoft Graph / protected-user binding only.
 * Human MCP access no longer requires microsoft_oid.
 */
export async function resolveMicrosoftOidActor(
  env: Env,
  oid: string,
  meta: { email?: string | null; name?: string | null; correlationId?: string | null } = {}
): Promise<ElvexActor> {
  const correlationId = meta.correlationId ?? null;
  if (!isMicrosoftOid(oid) || !env.EL_BUSINESS_DATA) {
    return unboundActor(correlationId, {
      identitySource: "microsoft_oidc",
      microsoftOid: oid,
      email: meta.email ?? null,
      displayName: meta.name ?? null,
    });
  }
  const user = await getUserByMicrosoftOid(env.EL_BUSINESS_DATA, oid);
  if (!user || user.status !== "active" || !isElvexRole(user.role)) {
    return unboundActor(correlationId, {
      actorId: user?.id ?? `oid:${oid}`,
      identitySource: "microsoft_oidc",
      microsoftOid: oid,
      email: user?.email ?? meta.email ?? null,
      displayName: user?.displayName ?? meta.name ?? null,
    });
  }
  return {
    principalType: "user",
    actorId: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    identityBound: true,
    identitySource: "microsoft_oidc",
    companyId: ELVEX_COMPANY_ID,
    correlationId,
    microsoftOid: user.microsoftOid ?? oid,
  };
}

function extractBearer(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

export function injectActor(actor: ElvexActor): ElvexActor {
  return { ...actor, identityBound: Boolean(actor.role || actor.serviceCapabilities?.length), identitySource: "injected" };
}

export async function signIdentityHeaders(
  secret: string,
  input: {
    actorId: string;
    email?: string | null;
    displayName?: string | null;
    principalType?: PrincipalType;
    timestamp?: string;
    correlationId?: string | null;
  }
): Promise<Record<string, string>> {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const principalType = input.principalType ?? "user";
  const email = input.email ?? "";
  const correlationId = input.correlationId ?? "";
  const payload = canonicalIdentityPayload({
    actorId: input.actorId,
    email,
    principalType,
    timestamp,
    correlationId,
  });
  const signature = await hmacHex(secret, payload);
  return {
    [IDENTITY_HEADER.actorId]: input.actorId,
    [IDENTITY_HEADER.email]: email,
    [IDENTITY_HEADER.displayName]: input.displayName ?? "",
    [IDENTITY_HEADER.principalType]: principalType,
    [IDENTITY_HEADER.timestamp]: timestamp,
    [IDENTITY_HEADER.correlationId]: correlationId,
    [IDENTITY_HEADER.signature]: signature,
  };
}

async function verifySignedIdentity(
  env: Env,
  request: Request
): Promise<{
  actorId: string;
  email: string;
  principalType: PrincipalType;
  correlationId: string | null;
} | null> {
  const secret = env.EL_RBAC_IDENTITY_SECRET?.trim();
  if (!secret) return null;

  const actorId = request.headers.get(IDENTITY_HEADER.actorId)?.trim();
  const email = request.headers.get(IDENTITY_HEADER.email)?.trim() ?? "";
  const principalTypeRaw = request.headers.get(IDENTITY_HEADER.principalType)?.trim() ?? "user";
  const timestamp = request.headers.get(IDENTITY_HEADER.timestamp)?.trim();
  const correlationId = request.headers.get(IDENTITY_HEADER.correlationId)?.trim() ?? "";
  const signature = request.headers.get(IDENTITY_HEADER.signature)?.trim();
  if (!actorId || !timestamp || !signature) return null;
  if (principalTypeRaw !== "user" && principalTypeRaw !== "service") return null;

  const age = Math.abs(Date.now() - Date.parse(timestamp));
  if (!Number.isFinite(age) || age > IDENTITY_MAX_AGE_MS) return null;

  const expected = await hmacHex(
    secret,
    canonicalIdentityPayload({
      actorId,
      email,
      principalType: principalTypeRaw,
      timestamp,
      correlationId,
    })
  );
  if (!timingSafeEqual(expected, signature)) return null;

  return {
    actorId,
    email,
    principalType: principalTypeRaw,
    correlationId: correlationId || null,
  };
}

function canonicalIdentityPayload(input: {
  actorId: string;
  email: string;
  principalType: string;
  timestamp: string;
  correlationId: string;
}): string {
  return [input.actorId, input.email.toLowerCase(), input.principalType, input.timestamp, input.correlationId].join("\n");
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export type UserSyncPayload = {
  externalId: string;
  email: string;
  displayName?: string | null;
  role: string;
  status?: "active" | "disabled";
  microsoftOid?: string | null;
  timestamp: string;
  signature: string;
};

export async function signUserSync(
  secret: string,
  input: {
    externalId: string;
    email: string;
    displayName?: string | null;
    role: string;
    status?: "active" | "disabled";
    microsoftOid?: string | null;
    timestamp?: string;
  }
): Promise<UserSyncPayload> {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const status = input.status ?? "active";
  const microsoftOid = input.microsoftOid?.trim() || null;
  const signature = await hmacHex(
    secret,
    canonicalUserSyncPayload({
      externalId: input.externalId,
      email: input.email,
      role: input.role,
      status,
      timestamp,
      microsoftOid,
    })
  );
  return {
    externalId: input.externalId,
    email: input.email,
    displayName: input.displayName ?? null,
    role: input.role,
    status,
    microsoftOid,
    timestamp,
    signature,
  };
}

export async function verifyUserSync(
  env: Env,
  body: Record<string, unknown> | null | undefined
): Promise<UserSyncPayload | null> {
  const secret = env.EL_RBAC_IDENTITY_SECRET?.trim();
  if (!secret || !body) return null;
  const externalId = typeof body.externalId === "string" ? body.externalId.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const role = typeof body.role === "string" ? body.role.trim() : "";
  const status = body.status === "disabled" ? "disabled" : "active";
  const timestamp = typeof body.timestamp === "string" ? body.timestamp.trim() : "";
  const signature = typeof body.signature === "string" ? body.signature.trim() : "";
  const displayName = typeof body.displayName === "string" ? body.displayName : null;
  const microsoftOid = typeof body.microsoftOid === "string" ? body.microsoftOid.trim() : "";
  if (!externalId || !email || !role || !timestamp || !signature) return null;
  const age = Math.abs(Date.now() - Date.parse(timestamp));
  if (!Number.isFinite(age) || age > IDENTITY_MAX_AGE_MS) return null;
  const expected = await hmacHex(
    secret,
    canonicalUserSyncPayload({
      externalId,
      email,
      role,
      status,
      timestamp,
      microsoftOid: microsoftOid || null,
    })
  );
  if (!timingSafeEqual(expected, signature)) return null;
  return {
    externalId,
    email,
    displayName,
    role,
    status,
    microsoftOid: microsoftOid || null,
    timestamp,
    signature,
  };
}

function canonicalUserSyncPayload(input: {
  externalId: string;
  email: string;
  role: string;
  status: string;
  timestamp: string;
  microsoftOid?: string | null;
}): string {
  const parts = ["user-sync", input.externalId, input.email.toLowerCase(), input.role, input.status, input.timestamp];
  if (input.microsoftOid) parts.push(input.microsoftOid);
  return parts.join("\n");
}

export function actorFromAssignment(input: {
  id: string;
  email: string | null;
  displayName?: string | null;
  role: ElvexRole;
  correlationId?: string | null;
}): ElvexActor {
  return {
    principalType: "user",
    actorId: input.id,
    email: input.email,
    displayName: input.displayName ?? null,
    role: input.role,
    identityBound: true,
    identitySource: "injected",
    companyId: ELVEX_COMPANY_ID,
    correlationId: input.correlationId ?? null,
  };
}
