import type { Env } from "../env";
import { ELVEX_COMPANY_ID, unboundActor, type ElvexActor, type PrincipalType } from "./actor";
import { isElvexRole, type ElvexRole } from "./roles";
import { getServicePrincipal, getUserByExternalId, getUserByEmail } from "./store";

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

  const verified = await verifySignedIdentity(env, request);
  if (!verified) return unboundActor(correlationId);

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
    return unboundActor(verified.correlationId);
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
  };
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
