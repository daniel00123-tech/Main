import { SignJWT, jwtVerify, decodeJwt } from "jose";
import type { Env } from "../../env";
import { infraPublicApiBase } from "../public-urls";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  CLOCK_SKEW_SECONDS,
  MCP_ACCESS_TYP,
  type InfraMcpAccessClaims,
} from "./types";
import { randomUrlToken } from "./crypto";

export function mcpOAuthSecret(env: Env): string {
  return (
    (typeof env.MCP_OAUTH_SECRET === "string" ? env.MCP_OAUTH_SECRET.trim() : "") ||
    env.SESSION_SECRET?.trim() ||
    ""
  );
}

export function mcpOAuthIssuer(env: Env, requestUrl?: string | URL | null): string {
  return infraPublicApiBase(env, requestUrl);
}

export function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

export function peekMcpAccessTyp(token: string): string | null {
  if (!looksLikeJwt(token)) return null;
  try {
    const payload = decodeJwt(token);
    return typeof payload.typ === "string" ? payload.typ : null;
  } catch {
    return null;
  }
}

export async function issueInfraMcpAccessToken(
  env: Env,
  input: {
    userId: string;
    companyId: string;
    companySlug: string;
    client: string;
    clientId?: string | null;
    email?: string | null;
    name?: string | null;
    resource?: string | null;
    scope?: string | null;
    ttlSeconds?: number;
    requestUrl?: string | URL | null;
  },
): Promise<{ accessToken: string; expiresIn: number; claims: InfraMcpAccessClaims } | null> {
  const secret = mcpOAuthSecret(env);
  if (!secret || !input.userId || !input.companyId) return null;
  const now = Math.floor(Date.now() / 1000);
  const ttl = input.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS;
  const issuer = mcpOAuthIssuer(env, input.requestUrl);
  const claims: InfraMcpAccessClaims = {
    iss: issuer,
    aud: input.resource?.trim() || `${issuer}/api/gateway/v1/mcp`,
    sub: input.userId,
    company_id: input.companyId,
    company_slug: input.companySlug,
    client: input.client,
    client_id: input.clientId?.trim() || undefined,
    email: input.email?.trim() || undefined,
    name: input.name?.trim() || undefined,
    typ: MCP_ACCESS_TYP,
    jti: randomUrlToken(16),
    iat: now,
    nbf: now,
    exp: now + ttl,
    scope: input.scope ?? "openid email profile offline_access",
  };
  const accessToken = await new SignJWT({
    company_id: claims.company_id,
    company_slug: claims.company_slug,
    client: claims.client,
    client_id: claims.client_id,
    email: claims.email,
    name: claims.name,
    typ: claims.typ,
    jti: claims.jti,
    nbf: claims.nbf,
    scope: claims.scope,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(claims.iss)
    .setAudience(claims.aud)
    .setSubject(claims.sub)
    .setIssuedAt(claims.iat)
    .setExpirationTime(claims.exp)
    .sign(new TextEncoder().encode(secret));
  return { accessToken, expiresIn: ttl, claims };
}

export async function verifyInfraMcpAccessToken(
  env: Env,
  token: string,
  requestUrl?: string | URL | null,
): Promise<InfraMcpAccessClaims | null> {
  const secret = mcpOAuthSecret(env);
  if (!secret || !looksLikeJwt(token)) return null;
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ["HS256"],
      clockTolerance: CLOCK_SKEW_SECONDS,
    });
    payload = verified.payload as Record<string, unknown>;
  } catch {
    return null;
  }
  if (payload.typ !== MCP_ACCESS_TYP) return null;
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  const companyId = typeof payload.company_id === "string" ? payload.company_id : "";
  const companySlug = typeof payload.company_slug === "string" ? payload.company_slug : "";
  if (!sub || !companyId || !companySlug) return null;
  if (typeof payload.role === "string") return null;
  const issuer = mcpOAuthIssuer(env, requestUrl);
  if (payload.iss !== issuer) return null;
  const now = Math.floor(Date.now() / 1000);
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || now > exp + CLOCK_SKEW_SECONDS) return null;
  return {
    iss: String(payload.iss),
    aud: String(payload.aud ?? ""),
    sub,
    company_id: companyId,
    company_slug: companySlug,
    client: typeof payload.client === "string" ? payload.client : "chatgpt",
    client_id: typeof payload.client_id === "string" ? payload.client_id : undefined,
    email: typeof payload.email === "string" ? payload.email : undefined,
    name: typeof payload.name === "string" ? payload.name : undefined,
    typ: MCP_ACCESS_TYP,
    jti: String(payload.jti ?? ""),
    iat: Number(payload.iat ?? 0),
    nbf: Number(payload.nbf ?? payload.iat ?? 0),
    exp,
    scope: typeof payload.scope === "string" ? payload.scope : undefined,
  };
}
