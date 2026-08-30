import type { Env } from "../env";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  CLOCK_SKEW_SECONDS,
  loadMcpOAuthConfig,
  mcpIssuer,
  mcpResourceUrl,
} from "./config";
import { fromBase64Url, hmacSha256, randomUrlToken, timingSafeEqual, toBase64Url } from "./crypto";

export type McpAccessClaims = {
  iss: string;
  aud: string;
  sub: string;
  oid: string;
  email?: string;
  name?: string;
  typ: "mcp_access";
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
    oid: string;
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
    sub: input.oid,
    oid: input.oid,
    email: input.email?.trim() || undefined,
    name: input.name?.trim() || undefined,
    typ: "mcp_access",
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
  if (payload.typ !== "mcp_access") return null;
  if (payload.iss !== config.issuer) return null;
  const aud = payload.aud;
  if (aud !== config.resource && aud !== config.issuer && aud !== `${config.issuer}/`) return null;
  const oid = typeof payload.oid === "string" ? payload.oid : typeof payload.sub === "string" ? payload.sub : "";
  if (!oid) return null;
  const now = Math.floor(Date.now() / 1000);
  const exp = Number(payload.exp);
  const nbf = Number(payload.nbf ?? payload.iat ?? 0);
  if (!Number.isFinite(exp) || now > exp + CLOCK_SKEW_SECONDS) return null;
  if (Number.isFinite(nbf) && now + CLOCK_SKEW_SECONDS < nbf) return null;
  return {
    iss: String(payload.iss),
    aud: String(payload.aud),
    sub: String(payload.sub ?? oid),
    oid,
    email: typeof payload.email === "string" ? payload.email : undefined,
    name: typeof payload.name === "string" ? payload.name : undefined,
    typ: "mcp_access",
    jti: String(payload.jti ?? ""),
    iat: Number(payload.iat ?? 0),
    nbf: Number(payload.nbf ?? 0),
    exp,
    scope: typeof payload.scope === "string" ? payload.scope : undefined,
  };
}
