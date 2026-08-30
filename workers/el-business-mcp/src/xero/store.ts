import type { ElXeroConfig } from "./config";
import { decryptJson, encryptJson } from "./crypto";
import { ElXeroError } from "./errors";

export type XeroTokenPayload = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  tokenType: string;
  scopes: string[];
};

export type XeroConnectionRow = {
  tenant_id: string;
  organisation_name: string | null;
  connection_id: string | null;
  scopes: string | null;
  token_nonce: string;
  token_ciphertext: string;
  access_expires_at: string | null;
  refresh_lock_until: string | null;
  last_refresh_at: string | null;
  last_api_at: string | null;
  last_api_ok: number | null;
  last_error: string | null;
};

export async function insertOauthState(
  db: D1Database,
  config: ElXeroConfig,
  stateHash: string,
  codeVerifier: string,
  ttlMs = 10 * 60 * 1000
): Promise<void> {
  const encrypted = await encryptJson(config, { codeVerifier });
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  await db
    .prepare(
      `INSERT INTO xero_oauth_states (state_hash, code_verifier_nonce, code_verifier_ciphertext, expires_at)
       VALUES (?, ?, ?, ?)`
    )
    .bind(stateHash, encrypted.nonce, encrypted.ciphertext, expiresAt)
    .run();
}

export async function consumeOauthState(
  db: D1Database,
  config: ElXeroConfig,
  stateHash: string
): Promise<string> {
  const row = await db
    .prepare(
      `SELECT code_verifier_nonce, code_verifier_ciphertext, expires_at, consumed_at
       FROM xero_oauth_states WHERE state_hash = ?`
    )
    .bind(stateHash)
    .first<{
      code_verifier_nonce: string;
      code_verifier_ciphertext: string;
      expires_at: string;
      consumed_at: string | null;
    }>();
  if (!row) {
    throw new ElXeroError("OAuth state is invalid or unknown.", "EL_XERO_OAUTH_STATE", 400);
  }
  if (row.consumed_at) {
    throw new ElXeroError("OAuth state has already been used.", "EL_XERO_OAUTH_STATE", 400);
  }
  if (Date.parse(row.expires_at) < Date.now()) {
    throw new ElXeroError("OAuth state has expired. Start connect again.", "EL_XERO_OAUTH_STATE", 400);
  }
  const consumed = await db
    .prepare(
      `UPDATE xero_oauth_states SET consumed_at = datetime('now')
       WHERE state_hash = ? AND consumed_at IS NULL`
    )
    .bind(stateHash)
    .run();
  if (!consumed.meta.changes) {
    throw new ElXeroError("OAuth state has already been used.", "EL_XERO_OAUTH_STATE", 400);
  }
  const payload = await decryptJson<{ codeVerifier: string }>(
    config,
    row.code_verifier_nonce,
    row.code_verifier_ciphertext
  );
  return payload.codeVerifier;
}

export async function loadConnectionRow(db: D1Database): Promise<XeroConnectionRow | null> {
  return db.prepare(`SELECT * FROM xero_connections WHERE id = 1`).first<XeroConnectionRow>();
}

export async function saveConnection(
  db: D1Database,
  config: ElXeroConfig,
  input: {
    tenantId: string;
    organisationName: string;
    connectionId?: string | null;
    scopes: string[];
    tokens: XeroTokenPayload;
  }
): Promise<void> {
  const encrypted = await encryptJson(config, input.tokens);
  await db
    .prepare(
      `INSERT INTO xero_connections
        (id, tenant_id, organisation_name, connection_id, scopes, token_nonce, token_ciphertext, access_expires_at, last_refresh_at, last_error, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         tenant_id = excluded.tenant_id,
         organisation_name = excluded.organisation_name,
         connection_id = excluded.connection_id,
         scopes = excluded.scopes,
         token_nonce = excluded.token_nonce,
         token_ciphertext = excluded.token_ciphertext,
         access_expires_at = excluded.access_expires_at,
         refresh_lock_until = NULL,
         last_refresh_at = datetime('now'),
         last_error = NULL,
         updated_at = datetime('now')`
    )
    .bind(
      input.tenantId,
      input.organisationName,
      input.connectionId ?? null,
      input.scopes.join(" "),
      encrypted.nonce,
      encrypted.ciphertext,
      input.tokens.expiresAt
    )
    .run();
}

export async function decryptTokens(config: ElXeroConfig, row: XeroConnectionRow): Promise<XeroTokenPayload> {
  return decryptJson<XeroTokenPayload>(config, row.token_nonce, row.token_ciphertext);
}

export async function tryAcquireRefreshLock(db: D1Database, lockMs = 30_000): Promise<boolean> {
  const until = new Date(Date.now() + lockMs).toISOString();
  const result = await db
    .prepare(
      `UPDATE xero_connections
       SET refresh_lock_until = ?, updated_at = datetime('now')
       WHERE id = 1 AND (refresh_lock_until IS NULL OR refresh_lock_until < datetime('now'))`
    )
    .bind(until)
    .run();
  return Boolean(result.meta.changes);
}

export async function clearRefreshLock(db: D1Database): Promise<void> {
  await db.prepare(`UPDATE xero_connections SET refresh_lock_until = NULL WHERE id = 1`).run();
}

export async function markApiCall(db: D1Database, ok: boolean, error?: string | null): Promise<void> {
  await db
    .prepare(
      `UPDATE xero_connections
       SET last_api_at = datetime('now'), last_api_ok = ?, last_error = ?, updated_at = datetime('now')
       WHERE id = 1`
    )
    .bind(ok ? 1 : 0, error ?? null)
    .run();
}

export async function deleteConnection(db: D1Database): Promise<void> {
  await db.prepare(`DELETE FROM xero_connections WHERE id = 1`).run();
}

export function connectionPublic(row: XeroConnectionRow | null) {
  if (!row) {
    return {
      connected: false,
      organisationName: null,
      tenantId: null,
      scopes: null,
      accessExpiresAt: null,
      lastRefreshAt: null,
      lastApiAt: null,
      lastApiOk: null,
    };
  }
  return {
    connected: true,
    organisationName: row.organisation_name,
    tenantId: row.tenant_id,
    scopes: row.scopes ? row.scopes.split(/\s+/) : [],
    accessExpiresAt: row.access_expires_at,
    lastRefreshAt: row.last_refresh_at,
    lastApiAt: row.last_api_at,
    lastApiOk: row.last_api_ok == null ? null : Boolean(row.last_api_ok),
  };
}
