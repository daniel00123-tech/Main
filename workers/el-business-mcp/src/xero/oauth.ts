import type { Env } from "../env";
import {
  loadXeroConfig,
  organisationMatchesExpected,
  XERO_AUTHORIZE_URL,
  XERO_CONNECTIONS_URL,
  XERO_SCOPE_STRING,
  XERO_TOKEN_URL,
  type ElXeroConfig,
} from "./config";
import { pkceChallenge, randomUrlToken, sha256Hex } from "./crypto";
import { ElXeroError, sanitizeErrorMessage } from "./errors";
import {
  consumeOauthState,
  deleteConnection,
  insertOauthState,
  loadConnectionRow,
  saveConnection,
  type XeroTokenPayload,
} from "./store";

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

type XeroConnection = {
  id?: string;
  tenantId?: string;
  tenantType?: string;
  tenantName?: string;
};

export function buildAuthorizeUrl(config: ElXeroConfig, state: string, challenge: string): string {
  const url = new URL(XERO_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", XERO_SCOPE_STRING);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function startXeroConnect(env: Env): Promise<{ authorizeUrl: string; expiresInSeconds: number }> {
  const config = loadXeroConfig(env);
  if (!config) {
    throw new ElXeroError("Xero client credentials are not configured.", "EL_XERO_NOT_CONFIGURED", 503);
  }
  const state = randomUrlToken(32);
  const verifier = randomUrlToken(48);
  const challenge = await pkceChallenge(verifier);
  await insertOauthState(env.EL_BUSINESS_DATA, config, await sha256Hex(state), verifier);
  return { authorizeUrl: buildAuthorizeUrl(config, state, challenge), expiresInSeconds: 600 };
}

async function exchangeToken(
  config: ElXeroConfig,
  body: URLSearchParams
): Promise<XeroTokenPayload> {
  const response = await fetch(XERO_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
    },
    body: body.toString(),
  });
  const payload = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || !payload.access_token || !payload.refresh_token) {
    throw new ElXeroError(
      sanitizeErrorMessage(payload.error_description ?? payload.error ?? `Token exchange failed (${response.status})`),
      "EL_XERO_TOKEN_DENIED",
      response.status || 401,
      response.status >= 500
    );
  }
  const expiresIn = Number(payload.expires_in ?? 1800);
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: new Date(Date.now() + Math.max(60, expiresIn) * 1000).toISOString(),
    tokenType: payload.token_type ?? "Bearer",
    scopes: (payload.scope ?? XERO_SCOPE_STRING).split(/\s+/).filter(Boolean),
  };
}

export async function exchangeAuthorizationCode(
  config: ElXeroConfig,
  code: string,
  verifier: string
): Promise<XeroTokenPayload> {
  return exchangeToken(
    config,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      code_verifier: verifier,
    })
  );
}

export async function refreshXeroTokens(config: ElXeroConfig, refreshToken: string): Promise<XeroTokenPayload> {
  return exchangeToken(
    config,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    })
  );
}

export async function listXeroConnections(accessToken: string): Promise<XeroConnection[]> {
  const response = await fetch(XERO_CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!response.ok) {
    throw new ElXeroError(
      sanitizeErrorMessage(`Unable to list Xero connections (${response.status})`),
      "EL_XERO_CONNECTIONS",
      response.status,
      response.status >= 500
    );
  }
  const rows = (await response.json()) as XeroConnection[];
  return Array.isArray(rows) ? rows : [];
}

export function selectElvexOrganisation(
  connections: XeroConnection[],
  expected: string
): XeroConnection {
  const organisations = connections.filter((row) => row.tenantId && row.tenantType !== "PRACTICE");
  const match = organisations.find((row) => organisationMatchesExpected(row.tenantName, expected));
  if (match) return match;
  const names = organisations.map((row) => row.tenantName).filter(Boolean);
  throw new ElXeroError(
    `Connected Xero organisation is not ${expected}. Received: ${names.join(", ") || "none"}. Tokens were not stored.`,
    "EL_XERO_TENANT_DENIED",
    403
  );
}

export async function completeXeroCallback(env: Env, url: URL): Promise<{ organisationName: string; tenantId: string }> {
  const config = loadXeroConfig(env);
  if (!config) {
    throw new ElXeroError("Xero client credentials are not configured.", "EL_XERO_NOT_CONFIGURED", 503);
  }
  const error = url.searchParams.get("error");
  if (error) {
    throw new ElXeroError(
      sanitizeErrorMessage(url.searchParams.get("error_description") ?? error),
      "EL_XERO_OAUTH_DENIED",
      400
    );
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    throw new ElXeroError("OAuth callback is missing code or state.", "EL_XERO_OAUTH_STATE", 400);
  }
  const verifier = await consumeOauthState(env.EL_BUSINESS_DATA, config, await sha256Hex(state));
  const tokens = await exchangeAuthorizationCode(config, code, verifier);
  const connections = await listXeroConnections(tokens.accessToken);
  const selected = selectElvexOrganisation(connections, config.expectedOrganisation);
  await saveConnection(env.EL_BUSINESS_DATA, config, {
    tenantId: selected.tenantId!,
    organisationName: selected.tenantName ?? config.expectedOrganisation,
    connectionId: selected.id ?? null,
    scopes: tokens.scopes,
    tokens,
  });
  return { organisationName: selected.tenantName ?? config.expectedOrganisation, tenantId: selected.tenantId! };
}

export async function disconnectXero(env: Env): Promise<void> {
  const config = loadXeroConfig(env);
  const row = await loadConnectionRow(env.EL_BUSINESS_DATA);
  if (config && row?.connection_id) {
    try {
      const { getValidAccessToken } = await import("./tokens");
      const token = await getValidAccessToken(env);
      await fetch(`${XERO_CONNECTIONS_URL}/${encodeURIComponent(row.connection_id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token.accessToken}` },
      });
    } catch {
      /* local disconnect still proceeds */
    }
  }
  await deleteConnection(env.EL_BUSINESS_DATA);
}
