import { newId, nowIso } from "../../db/mappers";
import { AUTH_CODE_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS, type McpOAuthClient } from "./types";
import { randomUrlToken, sha256Hex } from "./crypto";

export async function insertMcpOAuthClient(
  db: D1Database,
  input: {
    clientName: string;
    redirectUris: string[];
    tokenEndpointAuthMethod: "none" | "client_secret_post";
    clientSecretHash?: string | null;
  },
): Promise<McpOAuthClient> {
  const clientId = `mcp_${randomUrlToken(18)}`;
  await db
    .prepare(
      `INSERT INTO mcp_oauth_clients
        (id, client_id, client_name, redirect_uris_json, token_endpoint_auth_method, client_secret_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId("mcpcli"),
      clientId,
      input.clientName,
      JSON.stringify(input.redirectUris),
      input.tokenEndpointAuthMethod,
      input.clientSecretHash ?? null,
      nowIso(),
    )
    .run();
  return {
    clientId,
    clientName: input.clientName,
    redirectUris: input.redirectUris,
    tokenEndpointAuthMethod: input.tokenEndpointAuthMethod,
    clientSecretHash: input.clientSecretHash ?? null,
  };
}

export async function getMcpOAuthClient(
  db: D1Database,
  clientId: string,
): Promise<McpOAuthClient | null> {
  const row = await db
    .prepare(`SELECT * FROM mcp_oauth_clients WHERE client_id = ?`)
    .bind(clientId)
    .first();
  if (!row) return null;
  let redirectUris: string[] = [];
  try {
    redirectUris = JSON.parse(String(row.redirect_uris_json ?? "[]")) as string[];
  } catch {
    redirectUris = [];
  }
  return {
    clientId: String(row.client_id),
    clientName: String(row.client_name),
    redirectUris,
    tokenEndpointAuthMethod:
      row.token_endpoint_auth_method === "client_secret_post" ? "client_secret_post" : "none",
    clientSecretHash: row.client_secret_hash ? String(row.client_secret_hash) : null,
  };
}

export async function issueAuthorizationCode(
  db: D1Database,
  input: {
    clientId: string;
    userId: string;
    companyId: string;
    redirectUri: string;
    codeChallenge: string;
    resource?: string | null;
    scope?: string | null;
    clientType: string;
  },
): Promise<string> {
  const code = randomUrlToken(32);
  const expires = new Date(Date.now() + AUTH_CODE_TTL_SECONDS * 1000).toISOString();
  await db
    .prepare(
      `INSERT INTO mcp_oauth_codes
        (id, code_hash, client_id, user_id, company_id, redirect_uri, code_challenge,
         code_challenge_method, resource, scope, client_type, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'S256', ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId("mcpcode"),
      await sha256Hex(code),
      input.clientId,
      input.userId,
      input.companyId,
      input.redirectUri,
      input.codeChallenge,
      input.resource ?? null,
      input.scope ?? null,
      input.clientType,
      expires,
      nowIso(),
    )
    .run();
  return code;
}

export async function consumeAuthorizationCode(
  db: D1Database,
  code: string,
): Promise<{
  clientId: string;
  userId: string;
  companyId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string | null;
  scope: string | null;
  clientType: string;
} | null> {
  const hash = await sha256Hex(code);
  const row = await db
    .prepare(
      `SELECT * FROM mcp_oauth_codes
       WHERE code_hash = ? AND consumed_at IS NULL`,
    )
    .bind(hash)
    .first();
  if (!row) return null;
  if (String(row.expires_at) < nowIso()) return null;
  await db
    .prepare(`UPDATE mcp_oauth_codes SET consumed_at = ? WHERE id = ?`)
    .bind(nowIso(), String(row.id))
    .run();
  return {
    clientId: String(row.client_id),
    userId: String(row.user_id),
    companyId: String(row.company_id),
    redirectUri: String(row.redirect_uri),
    codeChallenge: String(row.code_challenge),
    resource: row.resource ? String(row.resource) : null,
    scope: row.scope ? String(row.scope) : null,
    clientType: String(row.client_type ?? "chatgpt"),
  };
}

export async function issueRefreshToken(
  db: D1Database,
  input: {
    clientId: string;
    userId: string;
    companyId: string;
    resource?: string | null;
    scope?: string | null;
    clientType: string;
  },
): Promise<string> {
  const token = randomUrlToken(32);
  const expires = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString();
  await db
    .prepare(
      `INSERT INTO mcp_oauth_refresh_tokens
        (id, token_hash, client_id, user_id, company_id, resource, scope, client_type, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId("mcprt"),
      await sha256Hex(token),
      input.clientId,
      input.userId,
      input.companyId,
      input.resource ?? null,
      input.scope ?? null,
      input.clientType,
      expires,
      nowIso(),
    )
    .run();
  return token;
}

export async function consumeRefreshToken(
  db: D1Database,
  token: string,
): Promise<{
  clientId: string;
  userId: string;
  companyId: string;
  resource: string | null;
  scope: string | null;
  clientType: string;
} | null> {
  const hash = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT * FROM mcp_oauth_refresh_tokens
       WHERE token_hash = ? AND revoked_at IS NULL`,
    )
    .bind(hash)
    .first();
  if (!row) return null;
  if (String(row.expires_at) < nowIso()) return null;
  await db
    .prepare(`UPDATE mcp_oauth_refresh_tokens SET revoked_at = ? WHERE id = ?`)
    .bind(nowIso(), String(row.id))
    .run();
  return {
    clientId: String(row.client_id),
    userId: String(row.user_id),
    companyId: String(row.company_id),
    resource: row.resource ? String(row.resource) : null,
    scope: row.scope ? String(row.scope) : null,
    clientType: String(row.client_type ?? "chatgpt"),
  };
}

export async function upsertMcpOAuthGrant(
  db: D1Database,
  input: { userId: string; companyId: string; clientType: string; clientId?: string | null },
) {
  const now = nowIso();
  const existing = await db
    .prepare(
      `SELECT id FROM mcp_oauth_grants
       WHERE user_id = ? AND company_id = ? AND client_type = ?`,
    )
    .bind(input.userId, input.companyId, input.clientType)
    .first();
  if (existing) {
    await db
      .prepare(
        `UPDATE mcp_oauth_grants
         SET status = 'active', client_id = ?, updated_at = ?, last_used_at = ?
         WHERE id = ?`,
      )
      .bind(input.clientId ?? null, now, now, String(existing.id))
      .run();
    return String(existing.id);
  }
  const id = newId("mcpgrant");
  await db
    .prepare(
      `INSERT INTO mcp_oauth_grants
        (id, user_id, company_id, client_type, client_id, status, created_at, updated_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    )
    .bind(id, input.userId, input.companyId, input.clientType, input.clientId ?? null, now, now, now)
    .run();
  return id;
}

export async function revokeMcpOAuthGrants(
  db: D1Database,
  input: { companyId: string; clientType: string; userId?: string | null },
) {
  const now = nowIso();
  if (input.userId) {
    await db
      .prepare(
        `UPDATE mcp_oauth_grants
         SET status = 'revoked', updated_at = ?
         WHERE company_id = ? AND client_type = ? AND user_id = ?`,
      )
      .bind(now, input.companyId, input.clientType, input.userId)
      .run();
    await db
      .prepare(
        `UPDATE mcp_oauth_refresh_tokens
         SET revoked_at = ?
         WHERE company_id = ? AND client_type = ? AND user_id = ? AND revoked_at IS NULL`,
      )
      .bind(now, input.companyId, input.clientType, input.userId)
      .run();
    return;
  }
  await db
    .prepare(
      `UPDATE mcp_oauth_grants
       SET status = 'revoked', updated_at = ?
       WHERE company_id = ? AND client_type = ?`,
    )
    .bind(now, input.companyId, input.clientType)
    .run();
  await db
    .prepare(
      `UPDATE mcp_oauth_refresh_tokens
       SET revoked_at = ?
       WHERE company_id = ? AND client_type = ? AND revoked_at IS NULL`,
    )
    .bind(now, input.companyId, input.clientType)
    .run();
}

export async function listActiveMcpOAuthGrants(
  db: D1Database,
  companyId: string,
  clientType?: string,
) {
  const query = clientType
    ? db
        .prepare(
          `SELECT * FROM mcp_oauth_grants
           WHERE company_id = ? AND client_type = ? AND status = 'active'`,
        )
        .bind(companyId, clientType)
    : db
        .prepare(
          `SELECT * FROM mcp_oauth_grants
           WHERE company_id = ? AND status = 'active'`,
        )
        .bind(companyId);
  try {
    const result = await query.all();
    return result.results ?? [];
  } catch {
    return [];
  }
}
