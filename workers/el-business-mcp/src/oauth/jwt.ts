import type { Env } from "../env";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  CLOCK_SKEW_SECONDS,
  ELVEX_COMPANY_ID,
  ELVEX_COMPANY_SLUG,
  loadMcpOAuthConfig,
  mcpIssuer,
  mcpResourceUrl,
} from "./config";
import { fromBase64Url, hmacSha256, randomUrlToken, timingSafeEqual, toBase64Url } from "./crypto";

export type McpAccessClaims = {
  iss: string;
  aud: string;
  sub: string;
  company_id: string;
  company_slug: string;
  client: string;
  email?: string;
  name?: string;
  typ: "infra_mcp_access";
  jti: string;
  iat: number;
  nbf: number;
  exp: number;
  scope?: string;
};

export async function signHs256Jwt(secret: string, payload: Record<string, unknown>): Promise<string> {
  const header = toBase64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = toBase64Url(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const sig = await hmacSha256(secret, signingInput);
  return `${signingInput}.${toBase64Url(sig)}`;
}

export async function verifyHs256Jwt(
  secret: string,
  token: string
): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(fromBase64Url(headerB64))) as {
      alg?: string;
      typ?: string;
    };
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null;
  const expected = toBase64Url(await hmacSha256(secret, `${headerB64}.${payloadB64}`));
  if (!timingSafeEqual(expected, sigB64)) return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function issueMcpAccessToken(
  env: Env,
  input: {
    userId: string;
    companyId?: string | null;
    companySlug?: string | null;
    client?: string | null;
    email?: string | null;
    name?: string | null;
    resource?: string | null;
    scope?: string | null;
    ttlSeconds?: number;
  }
): Promise<{ accessToken: string; expiresIn: number; claims: McpAccessClaims } | null> {
  const config = loadMcpOAuthConfig(env);
  if (!config) return null;
  const now = Math.floor(Date.now() / 1000);
  const ttl = input.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS;
  const claims: McpAccessClaims = {
    iss: mcpIssuer(env),
    aud: input.resource?.trim() || mcpResourceUrl(env),
    sub: input.userId,
    company_id: input.companyId?.trim() || ELVEX_COMPANY_ID,
    company_slug: input.companySlug?.trim() || ELVEX_COMPANY_SLUG,
    client: input.client?.trim() || "chatgpt",
    email: input.email?.trim() || undefined,
    name: input.name?.trim() || undefined,
    typ: "infra_mcp_access",
    jti: randomUrlToken(16),
    iat: now,
    nbf: now,
    exp: now + ttl,
    scope: input.scope ?? "openid email profile offline_access",
  };
  return {
    accessToken: await signHs256Jwt(config.tokenSecret, claims),
    expiresIn: ttl,
    claims,
  };
}

export async function verifyMcpAccessToken(env: Env, token: string): Promise<McpAccessClaims | null> {
  const config = loadMcpOAuthConfig(env);
  if (!config) return null;
  const payload = await verifyHs256Jwt(config.tokenSecret, token);
  if (!payload) return null;
  if (payload.typ !== "infra_mcp_access") return null;
  if (typeof payload.role === "string") return null;
  const allowedIssuers = new Set([config.issuer, config.publicOrigin, mcpIssuer(env)]);
  if (config.infraIssuer) allowedIssuers.add(config.infraIssuer);
  if (!allowedIssuers.has(String(payload.iss))) return null;
  const aud = String(payload.aud ?? "");
  const allowedAud = new Set([
    config.resource,
    config.issuer,
    `${config.issuer}/`,
    mcpResourceUrl(env),
    config.infraIssuer ? `${config.infraIssuer}/api/gateway/v1/mcp` : "",
  ]);
  if (aud && !allowedAud.has(aud)) return null;
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  const companyId = typeof payload.company_id === "string" ? payload.company_id : "";
  const companySlug = typeof payload.company_slug === "string" ? payload.company_slug : "";
  if (!sub || !companyId || !companySlug) return null;
  const now = Math.floor(Date.now() / 1000);
  const exp = Number(payload.exp);
  const nbf = Number(payload.nbf ?? payload.iat ?? 0);
  if (!Number.isFinite(exp) || now > exp + CLOCK_SKEW_SECONDS) return null;
  if (Number.isFinite(nbf) && now + CLOCK_SKEW_SECONDS < nbf) return null;
  return {
    iss: String(payload.iss),
    aud,
    sub,
    company_id: companyId,
    company_slug: companySlug,
    client: typeof payload.client === "string" ? payload.client : "chatgpt",
    email: typeof payload.email === "string" ? payload.email : undefined,
    name: typeof payload.name === "string" ? payload.name : undefined,
    typ: "infra_mcp_access",
    jti: String(payload.jti ?? ""),
    iat: Number(payload.iat ?? 0),
    nbf: Number(payload.nbf ?? 0),
    exp,
    scope: typeof payload.scope === "string" ? payload.scope : undefined,
  };
}

export function tokenCompanyIsElvex(claims: { company_id: string; company_slug: string }): boolean {
  return claims.company_id === ELVEX_COMPANY_ID || claims.company_slug === ELVEX_COMPANY_SLUG;
}
