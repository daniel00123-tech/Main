import { CONNECTOR_ERROR_CODES, customerConnectorError } from "@infra/shared";
import { newId, nowIso } from "../db/mappers";
import {
  decryptCredential,
  encryptCredential,
  readWrappingKeyMaterial,
  currentKeyVersion,
} from "./secrets/crypto";

const STATE_TTL_MS = 10 * 60 * 1000;

export interface OauthStartInput {
  companyId: string;
  userId: string;
  definitionId: string;
  instanceId?: string | null;
  redirectUri?: string | null;
  scopes?: string[];
  returnPath?: string | null;
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

export interface ConsumedOauthState {
  id: string;
  companyId: string;
  definitionId: string;
  userId: string;
  instanceId: string | null;
  redirectUri: string | null;
  scopes: string[];
  returnPath: string | null;
  codeVerifier: string | null;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function sha256Hex(value: string): Promise<string> {
  return [...(await sha256Bytes(value))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function pkceS256Challenge(verifier: string): Promise<string> {
  return bytesToBase64Url(await sha256Bytes(verifier));
}

function randomUrlSafe(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return bytesToBase64Url(buffer);
}

function wrappingKey(env?: Record<string, unknown> | null): string | null {
  if (!env) return null;
  return readWrappingKeyMaterial(env, currentKeyVersion(env));
}

export async function createOauthAuthorizationState(
  db: D1Database,
  input: OauthStartInput,
  env?: Record<string, unknown> | null,
): Promise<OauthAuthorizationState> {
  const id = newId("oauth");
  const state = randomUrlSafe(32);
  const codeVerifier = randomUrlSafe(48);
  const codeChallenge = await pkceS256Challenge(codeVerifier);
  const stateHash = await sha256Hex(state);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + STATE_TTL_MS).toISOString();
  const keyMaterial = wrappingKey(env);
  let nonceB64: string | null = null;
  let ciphertextB64: string | null = null;
  if (keyMaterial) {
    const sealed = await encryptCredential({
      plaintext: codeVerifier,
      keyMaterial,
      aad: `oauth-pkce|${input.companyId}|${id}`,
    });
    nonceB64 = sealed.nonceB64;
    ciphertextB64 = sealed.ciphertextB64;
  }

  await db
    .prepare(
      `INSERT INTO oauth_authorization_states (
        id, state_hash, company_id, connector_definition_id, connector_instance_id,
        user_id, code_challenge, code_challenge_method, redirect_uri, scopes_json,
        expires_at, consumed_at, created_at, code_verifier_nonce_b64,
        code_verifier_ciphertext_b64, return_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'S256', ?, ?, ?, NULL, ?, ?, ?, ?)`,
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
      nonceB64,
      ciphertextB64,
      input.returnPath ?? null,
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
  env?: Record<string, unknown> | null,
): Promise<
  | { ok: true; value: ConsumedOauthState }
  | { ok: false; error: ReturnType<typeof customerConnectorError> }
> {
  if (!input.state) {
    return { ok: false, error: customerConnectorError(CONNECTOR_ERROR_CODES.OAUTH_STATE_INVALID) };
  }
  const stateHash = await sha256Hex(input.state);
  const row = await db
    .prepare(`SELECT * FROM oauth_authorization_states WHERE state_hash = ?`)
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

  let codeVerifier: string | null = null;
  const nonce = row.code_verifier_nonce_b64 ? String(row.code_verifier_nonce_b64) : "";
  const ciphertext = row.code_verifier_ciphertext_b64
    ? String(row.code_verifier_ciphertext_b64)
    : "";
  const keyMaterial = wrappingKey(env);
  if (nonce && ciphertext && keyMaterial) {
    codeVerifier = await decryptCredential({
      nonceB64: nonce,
      ciphertextB64: ciphertext,
      keyMaterial,
      aad: `oauth-pkce|${String(row.company_id)}|${String(row.id)}`,
    });
  }

  await db
    .prepare(`UPDATE oauth_authorization_states SET consumed_at = ? WHERE id = ?`)
    .bind(nowIso(), String(row.id))
    .run();

  let scopes: string[] = [];
  try {
    const parsed = JSON.parse(String(row.scopes_json ?? "[]")) as unknown;
    if (Array.isArray(parsed)) scopes = parsed.map(String);
  } catch {
    scopes = [];
  }

  return {
    ok: true,
    value: {
      id: String(row.id),
      companyId: String(row.company_id),
      definitionId: String(row.connector_definition_id),
      userId: String(row.user_id),
      instanceId: row.connector_instance_id ? String(row.connector_instance_id) : null,
      redirectUri: row.redirect_uri ? String(row.redirect_uri) : null,
      scopes,
      returnPath: row.return_path ? String(row.return_path) : null,
      codeVerifier,
    },
  };
}

export function oauthProviderNotActivated() {
  return customerConnectorError(CONNECTOR_ERROR_CODES.OAUTH_NOT_ACTIVATED);
}

export function oauthAppNotConfigured() {
  return customerConnectorError(CONNECTOR_ERROR_CODES.OAUTH_APP_NOT_CONFIGURED);
}
