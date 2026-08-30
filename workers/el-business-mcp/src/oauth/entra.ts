import type { Env } from "../env";
import { CLOCK_SKEW_SECONDS, ENTRA_OIDC_SCOPES, loadMcpOAuthConfig, type McpOAuthConfig } from "./config";
import { fromBase64Url, isMicrosoftOid, toBase64Url } from "./crypto";

export type EntraIdentity = {
  oid: string;
  tid: string;
  email: string | null;
  name: string | null;
};

type Jwk = JsonWebKey & { kid?: string; kty?: string; alg?: string };

const jwksCache = new Map<string, { expiresAt: number; keys: Jwk[] }>();

export function clearEntraJwksCache(): void {
  jwksCache.clear();
}

export function buildEntraAuthorizeUrl(config: McpOAuthConfig, state: string): string {
  const url = new URL(config.entraAuthorizeUrl);
  url.searchParams.set("client_id", config.entraClientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.entraRedirectUri);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", ENTRA_OIDC_SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export async function exchangeEntraAuthorizationCode(
  env: Env,
  code: string
): Promise<EntraIdentity> {
  const config = loadMcpOAuthConfig(env);
  if (!config || !config.entraClientSecret) {
    throw new EntraOidcError("Microsoft Entra OIDC is not configured (client secret missing).", 503);
  }
  const body = new URLSearchParams({
    client_id: config.entraClientId,
    client_secret: config.entraClientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: config.entraRedirectUri,
    scope: ENTRA_OIDC_SCOPES,
  });
  const response = await fetch(config.entraTokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = (await response.json().catch(() => ({}))) as {
    id_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !payload.id_token) {
    throw new EntraOidcError(
      payload.error_description || payload.error || "Microsoft token exchange failed.",
      401
    );
  }
  const identity = await validateEntraIdToken(env, payload.id_token);
  if (!identity) {
    throw new EntraOidcError("Microsoft ID token failed tenant, audience, or signature checks.", 401);
  }
  return identity;
}

export async function validateEntraIdToken(env: Env, idToken: string): Promise<EntraIdentity | null> {
  const config = loadMcpOAuthConfig(env);
  if (!config) return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  let header: { alg?: string; kid?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(fromBase64Url(headerB64))) as {
      alg?: string;
      kid?: string;
    };
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64))) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (header.alg !== "RS256") return null;
  const keys = await loadEntraJwks(config.entraJwksUrl);
  const candidates = header.kid ? keys.filter((key) => key.kid === header.kid) : keys;
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = fromBase64Url(sigB64);
  let verified = false;
  for (const jwk of candidates.length ? candidates : keys) {
    if (await verifyRs256(jwk, data, signature)) {
      verified = true;
      break;
    }
  }
  if (!verified) return null;

  if (payload.iss !== config.entraIssuer) return null;
  if (String(payload.tid ?? "") !== config.tenantId) return null;
  const aud = payload.aud;
  const audiences = Array.isArray(aud) ? aud.map(String) : [String(aud ?? "")];
  if (!audiences.includes(config.entraClientId)) return null;

  const now = Math.floor(Date.now() / 1000);
  const exp = Number(payload.exp);
  const nbf = Number(payload.nbf ?? payload.iat ?? 0);
  if (!Number.isFinite(exp) || now > exp + CLOCK_SKEW_SECONDS) return null;
  if (Number.isFinite(nbf) && now + CLOCK_SKEW_SECONDS < nbf) return null;

  const oid = typeof payload.oid === "string" ? payload.oid.trim() : "";
  if (!isMicrosoftOid(oid)) return null;

  const email =
    (typeof payload.email === "string" && payload.email) ||
    (typeof payload.preferred_username === "string" && payload.preferred_username) ||
    (typeof payload.upn === "string" && payload.upn) ||
    null;
  const name = typeof payload.name === "string" ? payload.name : null;
  return { oid, tid: config.tenantId, email, name };
}

async function loadEntraJwks(jwksUrl: string): Promise<Jwk[]> {
  const cached = jwksCache.get(jwksUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;
  const response = await fetch(jwksUrl);
  if (!response.ok) return cached?.keys ?? [];
  const body = (await response.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache.set(jwksUrl, { keys, expiresAt: Date.now() + 10 * 60 * 1000 });
  return keys;
}

async function verifyRs256(jwk: Jwk, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    return crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature.buffer as ArrayBuffer,
      data.buffer as ArrayBuffer
    );
  } catch {
    return false;
  }
}

export class EntraOidcError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = "EntraOidcError";
    this.status = status;
  }
}

export function encodeRs256JwtForTests(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  signature: Uint8Array
): string {
  return `${toBase64Url(JSON.stringify(header))}.${toBase64Url(JSON.stringify(payload))}.${toBase64Url(signature)}`;
}
