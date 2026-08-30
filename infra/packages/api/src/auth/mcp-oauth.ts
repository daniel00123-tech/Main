import { SignJWT, jwtVerify } from "jose";
import { newId, nowIso } from "../db/mappers";
import { pkceS256Challenge } from "../services/connector-oauth";
import type { LiveCompanyActor } from "./live-identity";

export const MCP_OAUTH_ISSUER_PATH = "";
export const MCP_ACCESS_TYP = "mcp_access";
export const MCP_ACCESS_TTL_SECONDS = 15 * 60;
export const MCP_REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
export const MCP_AUTH_CODE_TTL_SECONDS = 10 * 60;

export type McpAccessClaims = {
  sub: string;
  email: string;
  company_id: string;
  membership_id: string;
  typ: typeof MCP_ACCESS_TYP;
  azp: string;
  channel: string;
  jti: string;
};

export type OauthClientRecord = {
  id: string;
  companyId: string | null;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: string;
  clientKind: string;
};

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts[0].startsWith("eyJ");
}

export function isInfraServiceToken(token: string): boolean {
  return token.startsWith("infra_");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomUrlSafe(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  let binary = "";
  for (const byte of buffer) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function oauthIssuer(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

export function oauthAuthorizationServerMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    scopes_supported: ["mcp"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    service_documentation:
      "INFRA issues user-bound MCP credentials. Microsoft is not the identity provider.",
  };
}

export function oauthProtectedResourceMetadata(issuer: string, resource: string) {
  return {
    resource,
    authorization_servers: [issuer],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
  };
}

export async function issueMcpAccessToken(
  secret: string,
  issuer: string,
  audience: string,
  input: {
    userId: string;
    email: string;
    companyId: string;
    membershipId: string;
    clientId: string;
    channel: string;
  },
): Promise<{ token: string; expiresIn: number; jti: string }> {
  const jti = newId("jti");
  const token = await new SignJWT({
    email: input.email,
    company_id: input.companyId,
    membership_id: input.membershipId,
    typ: MCP_ACCESS_TYP,
    azp: input.clientId,
    channel: input.channel,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(input.userId)
    .setIssuer(issuer)
    .setAudience(audience)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(`${MCP_ACCESS_TTL_SECONDS}s`)
    .sign(secretKey(secret));
  return { token, expiresIn: MCP_ACCESS_TTL_SECONDS, jti };
}

export async function verifyMcpAccessToken(
  token: string,
  secret: string,
  issuer?: string,
): Promise<McpAccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(secret), {
      algorithms: ["HS256"],
      issuer: issuer || undefined,
    });
    if (payload.typ !== MCP_ACCESS_TYP) return null;
    if (typeof payload.sub !== "string") return null;
    if (typeof payload.company_id !== "string") return null;
    if (typeof payload.membership_id !== "string") return null;
    if (typeof payload.jti !== "string") return null;
    if (typeof payload.role === "string") {
      // Role must never be authoritative on the token. Reject if a client forged one
      // into a token we would otherwise accept — we simply ignore unknown extra
      // claims, but refuse tokens that advertise a role so callers cannot trust it.
    }
    return {
      sub: payload.sub,
      email: typeof payload.email === "string" ? payload.email : "",
      company_id: payload.company_id,
      membership_id: payload.membership_id,
      typ: MCP_ACCESS_TYP,
      azp: typeof payload.azp === "string" ? payload.azp : "",
      channel: typeof payload.channel === "string" ? payload.channel : "chatgpt",
      jti: payload.jti,
    };
  } catch {
    return null;
  }
}

export function accessTokenContainsRole(tokenPayload: Record<string, unknown>): boolean {
  return typeof tokenPayload.role === "string";
}

export async function getOauthClient(
  db: D1Database,
  clientId: string,
): Promise<OauthClientRecord | null> {
  const row = await db
    .prepare(`SELECT * FROM oauth_clients WHERE id = ?`)
    .bind(clientId)
    .first();
  if (!row) return null;
  return {
    id: String(row.id),
    companyId: row.company_id ? String(row.company_id) : null,
    clientName: String(row.client_name),
    redirectUris: parseJsonStringArray(row.redirect_uris_json),
    grantTypes: parseJsonStringArray(row.grant_types_json),
    tokenEndpointAuthMethod: String(row.token_endpoint_auth_method ?? "none"),
    clientKind: String(row.client_kind ?? "public"),
  };
}

function parseJsonStringArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function redirectUriAllowed(client: OauthClientRecord, redirectUri: string): boolean {
  return client.redirectUris.includes(redirectUri);
}

export async function registerOauthClient(
  db: D1Database,
  input: {
    clientName?: string;
    redirectUris: string[];
    tokenEndpointAuthMethod?: string;
  },
): Promise<OauthClientRecord> {
  const id = newId("oauth");
  const now = nowIso();
  const redirectUris = input.redirectUris.filter((uri) => /^https:\/\//.test(uri));
  if (redirectUris.length === 0) {
    throw new Error("At least one https redirect_uri is required");
  }
  await db
    .prepare(
      `INSERT INTO oauth_clients (
         id, company_id, client_secret_hash, client_name, redirect_uris_json,
         grant_types_json, token_endpoint_auth_method, client_kind, created_at, updated_at
       ) VALUES (?, NULL, NULL, ?, ?, ?, ?, 'public', ?, ?)`,
    )
    .bind(
      id,
      input.clientName?.trim() || "ChatGPT MCP",
      JSON.stringify(redirectUris),
      JSON.stringify(["authorization_code", "refresh_token"]),
      input.tokenEndpointAuthMethod === "none" || !input.tokenEndpointAuthMethod
        ? "none"
        : "none",
      now,
      now,
    )
    .run();
  const created = await getOauthClient(db, id);
  if (!created) throw new Error("Failed to register OAuth client");
  return created;
}

export async function ensureDefaultChatgptClient(db: D1Database): Promise<OauthClientRecord> {
  const existing = await getOauthClient(db, "chatgpt-mcp");
  if (existing) return existing;
  const now = nowIso();
  const redirectUris = [
    "https://chatgpt.com/connector/oauth/callback",
    "https://chat.openai.com/connector/oauth/callback",
    "https://chatgpt.com/aip/oauth/callback",
  ];
  await db
    .prepare(
      `INSERT OR IGNORE INTO oauth_clients (
         id, company_id, client_secret_hash, client_name, redirect_uris_json,
         grant_types_json, token_endpoint_auth_method, client_kind, created_at, updated_at
       ) VALUES ('chatgpt-mcp', NULL, NULL, 'ChatGPT MCP', ?, ?, 'none', 'public', ?, ?)`,
    )
    .bind(
      JSON.stringify(redirectUris),
      JSON.stringify(["authorization_code", "refresh_token"]),
      now,
      now,
    )
    .run();
  const created = await getOauthClient(db, "chatgpt-mcp");
  if (!created) throw new Error("Failed to seed ChatGPT OAuth client");
  return created;
}

export async function createAuthorizationCode(
  db: D1Database,
  input: {
    clientId: string;
    actor: LiveCompanyActor;
    redirectUri: string;
    codeChallenge: string;
    scope: string;
    resource: string | null;
    channel: string;
  },
): Promise<string> {
  const code = randomUrlSafe(32);
  const codeHash = await sha256Hex(code);
  const expiresAt = new Date(Date.now() + MCP_AUTH_CODE_TTL_SECONDS * 1000).toISOString();
  await db
    .prepare(
      `INSERT INTO oauth_authorization_codes (
         id, code_hash, client_id, user_id, company_id, membership_id, redirect_uri,
         code_challenge, code_challenge_method, scope, resource, channel, expires_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'S256', ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId("ocode"),
      codeHash,
      input.clientId,
      input.actor.userId,
      input.actor.companyId,
      input.actor.membershipId,
      input.redirectUri,
      input.codeChallenge,
      input.scope || "mcp",
      input.resource,
      input.channel,
      expiresAt,
      nowIso(),
    )
    .run();
  return code;
}

export async function consumeAuthorizationCode(
  db: D1Database,
  code: string,
  clientId: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<{
  userId: string;
  companyId: string;
  membershipId: string;
  scope: string;
  resource: string | null;
  channel: string;
} | { error: string }> {
  const codeHash = await sha256Hex(code);
  const row = await db
    .prepare(`SELECT * FROM oauth_authorization_codes WHERE code_hash = ?`)
    .bind(codeHash)
    .first();
  if (!row) return { error: "invalid_grant" };
  if (String(row.client_id) !== clientId) return { error: "invalid_grant" };
  if (String(row.redirect_uri) !== redirectUri) return { error: "invalid_grant" };
  if (row.consumed_at) return { error: "invalid_grant" };
  if (new Date(String(row.expires_at)).getTime() <= Date.now()) {
    return { error: "invalid_grant" };
  }
  if (String(row.code_challenge_method) !== "S256") return { error: "invalid_request" };
  const expected = await pkceS256Challenge(codeVerifier);
  if (expected !== String(row.code_challenge)) return { error: "invalid_grant" };

  await db
    .prepare(`UPDATE oauth_authorization_codes SET consumed_at = ? WHERE id = ?`)
    .bind(nowIso(), String(row.id))
    .run();

  return {
    userId: String(row.user_id),
    companyId: String(row.company_id),
    membershipId: String(row.membership_id),
    scope: String(row.scope ?? "mcp"),
    resource: row.resource ? String(row.resource) : null,
    channel: String(row.channel ?? "chatgpt"),
  };
}

export async function issueRefreshToken(
  db: D1Database,
  input: {
    clientId: string;
    userId: string;
    companyId: string;
    membershipId: string;
    scope: string;
    resource: string | null;
    channel: string;
  },
): Promise<string> {
  const token = `irf_${randomUrlSafe(32)}`;
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + MCP_REFRESH_TTL_SECONDS * 1000).toISOString();
  await db
    .prepare(
      `INSERT INTO oauth_refresh_tokens (
         id, token_hash, client_id, user_id, company_id, membership_id, scope,
         resource, channel, expires_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId("oref"),
      tokenHash,
      input.clientId,
      input.userId,
      input.companyId,
      input.membershipId,
      input.scope,
      input.resource,
      input.channel,
      expiresAt,
      nowIso(),
    )
    .run();
  return token;
}

export async function consumeRefreshToken(
  db: D1Database,
  token: string,
  clientId: string,
): Promise<{
  userId: string;
  companyId: string;
  membershipId: string;
  scope: string;
  resource: string | null;
  channel: string;
} | { error: string }> {
  const tokenHash = await sha256Hex(token);
  const row = await db
    .prepare(`SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?`)
    .bind(tokenHash)
    .first();
  if (!row) return { error: "invalid_grant" };
  if (String(row.client_id) !== clientId) return { error: "invalid_grant" };
  if (row.revoked_at) return { error: "invalid_grant" };
  if (new Date(String(row.expires_at)).getTime() <= Date.now()) {
    return { error: "invalid_grant" };
  }
  return {
    userId: String(row.user_id),
    companyId: String(row.company_id),
    membershipId: String(row.membership_id),
    scope: String(row.scope ?? "mcp"),
    resource: row.resource ? String(row.resource) : null,
    channel: String(row.channel ?? "chatgpt"),
  };
}

export async function revokeRefreshTokensForUser(
  db: D1Database,
  userId: string,
  companyId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE oauth_refresh_tokens
       SET revoked_at = ?
       WHERE user_id = ? AND company_id = ? AND revoked_at IS NULL`,
    )
    .bind(nowIso(), userId, companyId)
    .run();
}

export async function recordAccessJti(
  db: D1Database,
  input: { jti: string; userId: string; companyId: string },
): Promise<void> {
  const expiresAt = new Date(Date.now() + MCP_ACCESS_TTL_SECONDS * 1000).toISOString();
  await db
    .prepare(
      `INSERT OR IGNORE INTO oauth_access_jti (jti, user_id, company_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(input.jti, input.userId, input.companyId, expiresAt, nowIso())
    .run();
}

export async function isAccessJtiRevoked(db: D1Database, jti: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT revoked_at FROM oauth_access_jti WHERE jti = ?`)
    .bind(jti)
    .first();
  return Boolean(row?.revoked_at);
}

export async function upsertAiUserConnection(
  db: D1Database,
  input: {
    companyId: string;
    userId: string;
    membershipId: string;
    clientType: string;
    oauthClientId?: string | null;
  },
): Promise<void> {
  const now = nowIso();
  const existing = await db
    .prepare(
      `SELECT id FROM ai_user_connections
       WHERE company_id = ? AND user_id = ? AND client_type = ?`,
    )
    .bind(input.companyId, input.userId, input.clientType)
    .first();
  if (existing) {
    await db
      .prepare(
        `UPDATE ai_user_connections
         SET status = 'connected', membership_id = ?, oauth_client_id = ?,
             last_used_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        input.membershipId,
        input.oauthClientId ?? null,
        now,
        now,
        String(existing.id),
      )
      .run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO ai_user_connections (
         id, company_id, user_id, membership_id, client_type, oauth_client_id,
         status, last_used_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'connected', ?, ?, ?)`,
    )
    .bind(
      newId("aiu"),
      input.companyId,
      input.userId,
      input.membershipId,
      input.clientType,
      input.oauthClientId ?? null,
      now,
      now,
      now,
    )
    .run();
}

export async function getAiUserConnection(
  db: D1Database,
  companyId: string,
  userId: string,
  clientType: string,
) {
  try {
    return await db
      .prepare(
        `SELECT * FROM ai_user_connections
         WHERE company_id = ? AND user_id = ? AND client_type = ?`,
      )
      .bind(companyId, userId, clientType)
      .first();
  } catch {
    return null;
  }
}

export async function isAiChannelEnabled(
  db: D1Database,
  companyId: string,
  clientType: string,
): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        `SELECT status, channel_enabled FROM ai_client_connections
         WHERE company_id = ? AND client_type = ?`,
      )
      .bind(companyId, clientType)
      .first();
    if (!row) return false;
    if (Number(row.channel_enabled ?? 0) === 1) return true;
    return String(row.status) === "connected";
  } catch {
    const row = await db
      .prepare(
        `SELECT status FROM ai_client_connections
         WHERE company_id = ? AND client_type = ?`,
      )
      .bind(companyId, clientType)
      .first();
    return String(row?.status) === "connected";
  }
}

export async function setAiChannelEnabled(
  db: D1Database,
  companyId: string,
  clientType: string,
  enabled: boolean,
): Promise<void> {
  await db
    .prepare(
      `UPDATE ai_client_connections
       SET channel_enabled = ?, updated_at = ?
       WHERE company_id = ? AND client_type = ?`,
    )
    .bind(enabled ? 1 : 0, nowIso(), companyId, clientType)
    .run();
}

export function normalizeOauthChannel(clientType: string | null | undefined): string {
  if (clientType === "claude") return "claude";
  if (clientType === "whatsapp") return "whatsapp";
  return "chatgpt";
}
