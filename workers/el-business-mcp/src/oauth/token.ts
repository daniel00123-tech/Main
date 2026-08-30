import type { Env } from "../env";
import { infraTokenUrl, mcpIssuer, mcpResourceUrl } from "./config";
import { oauthJson } from "./cors";
import { OAuthRequestError, resolveOAuthClient } from "./dcr";
import { sha256Base64Url, sha256Hex, timingSafeEqual } from "./crypto";
import { issueMcpAccessToken } from "./jwt";
import {
  consumeAuthorizationCode,
  consumeRefreshToken,
  getOAuthClient,
  issueRefreshToken,
} from "./store";

export async function handleToken(request: Request, env: Env): Promise<Response> {
  const infra = infraTokenUrl(env);
  if (infra) {
    const body = await request.clone().arrayBuffer();
    const proxied = await fetch(infra, {
      method: "POST",
      headers: {
        "Content-Type": request.headers.get("Content-Type") ?? "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });
    return oauthJson(request, await proxied.json().catch(() => ({ error: "server_error" })), proxied.status);
  }
  const form = await readForm(request);
  const grantType = form.get("grant_type") ?? "";
  try {
    if (grantType === "authorization_code") {
      return oauthJson(request, await exchangeAuthorizationCode(env, form));
    }
    if (grantType === "refresh_token") {
      return oauthJson(request, await exchangeRefreshToken(env, form));
    }
    throw new OAuthRequestError("unsupported_grant_type", "Only authorization_code and refresh_token are supported.");
  } catch (error) {
    if (error instanceof OAuthRequestError) {
      return oauthJson(
        request,
        { error: error.error, error_description: error.message },
        error.status
      );
    }
    return oauthJson(request, { error: "server_error", error_description: "Token endpoint failed." }, 500);
  }
}

export async function handleUserinfo(request: Request, env: Env): Promise<Response> {
  const { verifyMcpAccessToken } = await import("./jwt");
  const token = bearerToken(request);
  if (!token) {
    return oauthJson(request, { error: "invalid_token", error_description: "Bearer token required." }, 401);
  }
  const claims = await verifyMcpAccessToken(env, token);
  if (!claims) {
    return oauthJson(request, { error: "invalid_token", error_description: "Access token is invalid or expired." }, 401);
  }
  return oauthJson(request, {
    sub: claims.sub,
    email: claims.email ?? null,
    name: claims.name ?? null,
    company_id: claims.company_id,
    company_slug: claims.company_slug,
    client: claims.client,
    email_verified: Boolean(claims.email),
    iss: mcpIssuer(env),
  });
}

export async function handleRevoke(request: Request, env: Env): Promise<Response> {
  const form = await readForm(request);
  const token = form.get("token") ?? "";
  if (token) {
    await consumeRefreshToken(env, token).catch(() => null);
  }
  return oauthJson(request, { revoked: true });
}

async function exchangeAuthorizationCode(env: Env, form: URLSearchParams): Promise<Record<string, unknown>> {
  const code = form.get("code") ?? "";
  const redirectUri = form.get("redirect_uri") ?? "";
  const clientId = form.get("client_id") ?? "";
  const codeVerifier = form.get("code_verifier") ?? "";
  const resource = form.get("resource") || mcpResourceUrl(env);
  if (!code || !redirectUri || !clientId || !codeVerifier) {
    throw new OAuthRequestError("invalid_request", "code, client_id, redirect_uri, and code_verifier are required.");
  }
  const stored = await consumeAuthorizationCode(env, code);
  if (!stored) {
    throw new OAuthRequestError("invalid_grant", "Authorization code is invalid, expired, or already used.");
  }
  if (stored.clientId !== clientId || stored.redirectUri !== redirectUri) {
    throw new OAuthRequestError("invalid_grant", "Authorization code client or redirect_uri mismatch.");
  }
  if (stored.resource && stored.resource !== resource) {
    throw new OAuthRequestError("invalid_target", "resource does not match the authorized resource.");
  }
  const client = (await getOAuthClient(env, clientId)) ?? (await resolveOAuthClient(env, clientId, redirectUri));
  if (!client) {
    throw new OAuthRequestError("invalid_client", "Unknown OAuth client.", 401);
  }
  await assertClientAuth(form, client);
  if (stored.codeChallengeMethod !== "S256") {
    throw new OAuthRequestError("invalid_grant", "PKCE S256 is required.");
  }
  const challenge = await sha256Base64Url(codeVerifier);
  if (!timingSafeEqual(challenge, stored.codeChallenge)) {
    throw new OAuthRequestError("invalid_grant", "PKCE verification failed.");
  }
  return issueTokenSet(env, {
    userId: stored.oid,
    email: stored.email,
    name: stored.displayName,
    resource,
    scope: stored.scope,
    clientId,
  });
}

async function exchangeRefreshToken(env: Env, form: URLSearchParams): Promise<Record<string, unknown>> {
  const refreshToken = form.get("refresh_token") ?? "";
  const clientId = form.get("client_id") ?? "";
  if (!refreshToken || !clientId) {
    throw new OAuthRequestError("invalid_request", "refresh_token and client_id are required.");
  }
  const stored = await consumeRefreshToken(env, refreshToken);
  if (!stored || stored.clientId !== clientId) {
    throw new OAuthRequestError("invalid_grant", "Refresh token is invalid, expired, or revoked.");
  }
  const client = await getOAuthClient(env, clientId);
  if (client) await assertClientAuth(form, client);
  return issueTokenSet(env, {
    userId: stored.oid,
    email: stored.email,
    name: stored.displayName,
    resource: stored.resource || form.get("resource") || mcpResourceUrl(env),
    scope: stored.scope,
    clientId,
  });
}

async function issueTokenSet(
  env: Env,
  input: {
    userId: string;
    email: string | null;
    name: string | null;
    resource: string;
    scope: string | null;
    clientId: string;
  }
): Promise<Record<string, unknown>> {
  const issued = await issueMcpAccessToken(env, {
    userId: input.userId,
    email: input.email,
    name: input.name,
    resource: input.resource,
    scope: input.scope,
  });
  if (!issued) {
    throw new OAuthRequestError("temporarily_unavailable", "Token signing is not configured.", 503);
  }
  const refreshToken = await issueRefreshToken(env, {
    clientId: input.clientId,
    oid: input.userId,
    email: input.email,
    displayName: input.name,
    resource: input.resource,
    scope: input.scope,
  });
  return {
    access_token: issued.accessToken,
    token_type: "Bearer",
    expires_in: issued.expiresIn,
    refresh_token: refreshToken,
    scope: issued.claims.scope,
    iss: mcpIssuer(env),
  };
}

async function assertClientAuth(
  form: URLSearchParams,
  client: { tokenEndpointAuthMethod: string; clientSecretHash: string | null }
): Promise<void> {
  if (client.tokenEndpointAuthMethod === "none") return;
  const secret = form.get("client_secret") ?? "";
  if (!client.clientSecretHash || !secret) {
    throw new OAuthRequestError("invalid_client", "Client authentication failed.", 401);
  }
  const hash = await sha256Hex(secret);
  if (!timingSafeEqual(hash, client.clientSecretHash)) {
    throw new OAuthRequestError("invalid_client", "Client authentication failed.", 401);
  }
}

async function readForm(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === "string") params.set(key, value);
    }
    return params;
  }
  return new URLSearchParams(await request.text());
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}
