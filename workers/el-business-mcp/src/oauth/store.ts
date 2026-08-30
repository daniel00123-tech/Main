import type { Env } from "../env";
import {
  AUTH_CODE_TTL_SECONDS,
  AUTHORIZE_STATE_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
} from "./config";
import { randomUrlToken, sha256Hex } from "./crypto";

export type OAuthClientRow = {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none" | "client_secret_post";
  clientSecretHash: string | null;
};

export type AuthorizeStateRow = {
  id: string;
  clientId: string;
  redirectUri: string;
  clientState: string | null;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string | null;
  resource: string | null;
};

export type AuthorizationCodeRow = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  oid: string;
  email: string | null;
  displayName: string | null;
  resource: string | null;
  scope: string | null;
  usedAt: string | null;
  expiresAt: number;
};

export type RefreshTokenRow = {
  clientId: string;
  oid: string;
  email: string | null;
  displayName: string | null;
  resource: string | null;
  scope: string | null;
  revokedAt: string | null;
  expiresAt: number;
};

export async function insertOAuthClient(
  env: Env,
  input: {
    clientId?: string;
    clientName?: string | null;
    redirectUris: string[];
    tokenEndpointAuthMethod?: "none" | "client_secret_post";
    clientSecretHash?: string | null;
  }
): Promise<OAuthClientRow> {
  const clientId = input.clientId ?? crypto.randomUUID();
  const now = new Date().toISOString();
  await env.EL_BUSINESS_DATA.prepare(
    `INSERT INTO oauth_clients (
       client_id, client_name, redirect_uris_json, token_endpoint_auth_method,
       client_secret_hash, grant_types_json, response_types_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      clientId,
      input.clientName ?? null,
      JSON.stringify(input.redirectUris),
      input.tokenEndpointAuthMethod ?? "none",
      input.clientSecretHash ?? null,
      JSON.stringify(["authorization_code", "refresh_token"]),
      JSON.stringify(["code"]),
      now
    )
    .run();
  return {
    clientId,
    clientName: input.clientName ?? null,
    redirectUris: input.redirectUris,
    tokenEndpointAuthMethod: input.tokenEndpointAuthMethod ?? "none",
    clientSecretHash: input.clientSecretHash ?? null,
  };
}

export async function getOAuthClient(env: Env, clientId: string): Promise<OAuthClientRow | null> {
  const row = await env.EL_BUSINESS_DATA.prepare(
    `SELECT client_id, client_name, redirect_uris_json, token_endpoint_auth_method, client_secret_hash
     FROM oauth_clients WHERE client_id = ?`
  )
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
    clientName: row.client_name ? String(row.client_name) : null,
    redirectUris,
    tokenEndpointAuthMethod:
      String(row.token_endpoint_auth_method) === "client_secret_post" ? "client_secret_post" : "none",
    clientSecretHash: row.client_secret_hash ? String(row.client_secret_hash) : null,
  };
}

export async function createAuthorizeState(
  env: Env,
  input: {
    clientId: string;
    redirectUri: string;
    clientState: string | null;
    codeChallenge: string;
    codeChallengeMethod: string;
    scope: string | null;
    resource: string | null;
  }
): Promise<string> {
  const id = randomUrlToken(24);
  const expiresAt = Math.floor(Date.now() / 1000) + AUTHORIZE_STATE_TTL_SECONDS;
  await env.EL_BUSINESS_DATA.prepare(
    `INSERT INTO oauth_authorize_states (
       id, client_id, redirect_uri, client_state, code_challenge, code_challenge_method,
       scope, resource, expires_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      input.clientId,
      input.redirectUri,
      input.clientState,
      input.codeChallenge,
      input.codeChallengeMethod,
      input.scope,
      input.resource,
      expiresAt,
      new Date().toISOString()
    )
    .run();
  return id;
}

export async function consumeAuthorizeState(env: Env, id: string): Promise<AuthorizeStateRow | null> {
  const row = await env.EL_BUSINESS_DATA.prepare(
    `SELECT id, client_id, redirect_uri, client_state, code_challenge, code_challenge_method,
            scope, resource, expires_at
     FROM oauth_authorize_states WHERE id = ?`
  )
    .bind(id)
    .first();
  if (!row) return null;
  await env.EL_BUSINESS_DATA.prepare(`DELETE FROM oauth_authorize_states WHERE id = ?`).bind(id).run();
  if (Number(row.expires_at) < Math.floor(Date.now() / 1000)) return null;
  return {
    id: String(row.id),
    clientId: String(row.client_id),
    redirectUri: String(row.redirect_uri),
    clientState: row.client_state ? String(row.client_state) : null,
    codeChallenge: String(row.code_challenge),
    codeChallengeMethod: String(row.code_challenge_method),
    scope: row.scope ? String(row.scope) : null,
    resource: row.resource ? String(row.resource) : null,
  };
}

export async function issueAuthorizationCode(
  env: Env,
  input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    oid: string;
    email: string | null;
    displayName: string | null;
    resource: string | null;
    scope: string | null;
  }
): Promise<string> {
  const code = randomUrlToken(32);
  const codeHash = await sha256Hex(code);
  const expiresAt = Math.floor(Date.now() / 1000) + AUTH_CODE_TTL_SECONDS;
  await env.EL_BUSINESS_DATA.prepare(
    `INSERT INTO oauth_authorization_codes (
       code_hash, client_id, redirect_uri, code_challenge, code_challenge_method,
       oid, email, display_name, resource, scope, expires_at, used_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
  )
    .bind(
      codeHash,
      input.clientId,
      input.redirectUri,
      input.codeChallenge,
      input.codeChallengeMethod,
      input.oid,
      input.email,
      input.displayName,
      input.resource,
      input.scope,
      expiresAt,
      new Date().toISOString()
    )
    .run();
  return code;
}

export async function consumeAuthorizationCode(env: Env, code: string): Promise<AuthorizationCodeRow | null> {
  const codeHash = await sha256Hex(code);
  const row = await env.EL_BUSINESS_DATA.prepare(
    `SELECT client_id, redirect_uri, code_challenge, code_challenge_method, oid, email,
            display_name, resource, scope, expires_at, used_at
     FROM oauth_authorization_codes WHERE code_hash = ?`
  )
    .bind(codeHash)
    .first();
  if (!row) return null;
  if (row.used_at) return null;
  if (Number(row.expires_at) < Math.floor(Date.now() / 1000)) return null;
  await env.EL_BUSINESS_DATA.prepare(
    `UPDATE oauth_authorization_codes SET used_at = ? WHERE code_hash = ?`
  )
    .bind(new Date().toISOString(), codeHash)
    .run();
  return {
    clientId: String(row.client_id),
    redirectUri: String(row.redirect_uri),
    codeChallenge: String(row.code_challenge),
    codeChallengeMethod: String(row.code_challenge_method),
    oid: String(row.oid),
    email: row.email ? String(row.email) : null,
    displayName: row.display_name ? String(row.display_name) : null,
    resource: row.resource ? String(row.resource) : null,
    scope: row.scope ? String(row.scope) : null,
    usedAt: null,
    expiresAt: Number(row.expires_at),
  };
}

export async function issueRefreshToken(
  env: Env,
  input: {
    clientId: string;
    oid: string;
    email: string | null;
    displayName: string | null;
    resource: string | null;
    scope: string | null;
  }
): Promise<string> {
  const token = randomUrlToken(40);
  const tokenHash = await sha256Hex(token);
  const expiresAt = Math.floor(Date.now() / 1000) + REFRESH_TOKEN_TTL_SECONDS;
  await env.EL_BUSINESS_DATA.prepare(
    `INSERT INTO oauth_refresh_tokens (
       token_hash, client_id, oid, email, display_name, resource, scope, expires_at, revoked_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
  )
    .bind(
      tokenHash,
      input.clientId,
      input.oid,
      input.email,
      input.displayName,
      input.resource,
      input.scope,
      expiresAt,
      new Date().toISOString()
    )
    .run();
  return token;
}

export async function consumeRefreshToken(env: Env, token: string): Promise<RefreshTokenRow | null> {
  const tokenHash = await sha256Hex(token);
  const row = await env.EL_BUSINESS_DATA.prepare(
    `SELECT client_id, oid, email, display_name, resource, scope, expires_at, revoked_at
     FROM oauth_refresh_tokens WHERE token_hash = ?`
  )
    .bind(tokenHash)
    .first();
  if (!row) return null;
  await env.EL_BUSINESS_DATA.prepare(
    `UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE token_hash = ?`
  )
    .bind(new Date().toISOString(), tokenHash)
    .run();
  if (row.revoked_at) return null;
  if (Number(row.expires_at) < Math.floor(Date.now() / 1000)) return null;
  return {
    clientId: String(row.client_id),
    oid: String(row.oid),
    email: row.email ? String(row.email) : null,
    displayName: row.display_name ? String(row.display_name) : null,
    resource: row.resource ? String(row.resource) : null,
    scope: row.scope ? String(row.scope) : null,
    revokedAt: null,
    expiresAt: Number(row.expires_at),
  };
}
