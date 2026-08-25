import { CONNECTOR_ERROR_CODES, customerConnectorError } from "@infra/shared";
import { newId, nowIso } from "../db/mappers";

const STATE_TTL_MS = 10 * 60 * 1000;

export interface OauthStartInput {
  companyId: string;
  userId: string;
  definitionId: string;
  instanceId?: string | null;
  redirectUri?: string | null;
  scopes?: string[];
}

export interface OauthAuthorizationState {
  id: string;
  state: string;
  stateHash: string;
  codeVerifier: string;
  codeChallenge: string;
  companyId: string;
  expiresAt: string;
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
  return btoa(String.fromCharCode(...buffer))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export async function createOauthAuthorizationState(
  db: D1Database,
  input: OauthStartInput,
): Promise<OauthAuthorizationState> {
  const id = newId("oauth");
  const state = randomUrlSafe(32);
  const codeVerifier = randomUrlSafe(48);
  const codeChallenge = await sha256Hex(codeVerifier);
  const stateHash = await sha256Hex(state);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + STATE_TTL_MS).toISOString();

  await db
    .prepare(
      `INSERT INTO oauth_authorization_states (
        id, state_hash, company_id, connector_definition_id, connector_instance_id,
        user_id, code_challenge, code_challenge_method, redirect_uri, scopes_json,
        expires_at, consumed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'S256', ?, ?, ?, NULL, ?)`,
    )
    .bind(
      id,
      stateHash,
      input.companyId,
      input.definitionId,
      input.instanceId ?? null,
      input.userId,
      codeChallenge,
      input.redirectUri ?? null,
      JSON.stringify(input.scopes ?? []),
      expiresAt,
      createdAt,
    )
    .run();

  return {
    id,
    state,
    stateHash,
    codeVerifier,
    codeChallenge,
    companyId: input.companyId,
    expiresAt,
  };
}

export async function consumeOauthAuthorizationState(
  db: D1Database,
  input: { state: string; companyId?: string; userId?: string },
): Promise<
  | { ok: true; companyId: string; definitionId: string; userId: string; instanceId: string | null }
  | { ok: false; error: ReturnType<typeof customerConnectorError> }
> {
  if (!input.state) {
    return { ok: false, error: customerConnectorError(CONNECTOR_ERROR_CODES.OAUTH_STATE_INVALID) };
  }
  const stateHash = await sha256Hex(input.state);
  const row = await db
    .prepare(
      `SELECT * FROM oauth_authorization_states WHERE state_hash = ?`,
    )
    .bind(stateHash)
    .first();

  if (!row) {
    return { ok: false, error: customerConnectorError(CONNECTOR_ERROR_CODES.OAUTH_STATE_INVALID) };
  }
  if (row.consumed_at) {
    return { ok: false, error: customerConnectorError(CONNECTOR_ERROR_CODES.OAUTH_STATE_INVALID) };
  }
  if (String(row.expires_at) < nowIso()) {
    return { ok: false, error: customerConnectorError(CONNECTOR_ERROR_CODES.OAUTH_STATE_INVALID) };
  }
  if (input.companyId && String(row.company_id) !== input.companyId) {
    return { ok: false, error: customerConnectorError(CONNECTOR_ERROR_CODES.OAUTH_STATE_INVALID) };
  }
  if (input.userId && String(row.user_id) !== input.userId) {
    return { ok: false, error: customerConnectorError(CONNECTOR_ERROR_CODES.OAUTH_STATE_INVALID) };
  }

  await db
    .prepare(
      `UPDATE oauth_authorization_states SET consumed_at = ? WHERE id = ?`,
    )
    .bind(nowIso(), String(row.id))
    .run();

  return {
    ok: true,
    companyId: String(row.company_id),
    definitionId: String(row.connector_definition_id),
    userId: String(row.user_id),
    instanceId: row.connector_instance_id ? String(row.connector_instance_id) : null,
  };
}

export function oauthProviderNotActivated() {
  return customerConnectorError(CONNECTOR_ERROR_CODES.OAUTH_NOT_ACTIVATED);
}
