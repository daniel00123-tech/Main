import type { Env } from "../env";
import { loadMcpOAuthConfig, mcpIssuer, mcpResourceUrl } from "./config";
import { withOauthCors } from "./cors";
import { OAuthRequestError, resolveOAuthClient } from "./dcr";
import { EntraOidcError, buildEntraAuthorizeUrl, exchangeEntraAuthorizationCode } from "./entra";
import { createAuthorizeState, consumeAuthorizeState, issueAuthorizationCode } from "./store";

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const responseType = url.searchParams.get("response_type") ?? "";
  const clientId = url.searchParams.get("client_id") ?? "";
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const state = url.searchParams.get("state");
  const codeChallenge = url.searchParams.get("code_challenge") ?? "";
  const codeChallengeMethod = url.searchParams.get("code_challenge_method") ?? "";
  const scope = url.searchParams.get("scope");
  const resource = url.searchParams.get("resource") || mcpResourceUrl(env);

  if (responseType !== "code") {
    return authorizeError(env, redirectUri, state, "unsupported_response_type", "Only response_type=code is supported.");
  }
  if (codeChallengeMethod !== "S256" || !codeChallenge) {
    return authorizeError(env, redirectUri, state, "invalid_request", "PKCE S256 code_challenge is required.");
  }
  const client = await resolveOAuthClient(env, clientId, redirectUri);
  if (!client) {
    return oauthHtmlError("Unknown or unregistered OAuth client, or redirect_uri mismatch.", 400);
  }
  const config = loadMcpOAuthConfig(env);
  if (!config) {
    return oauthHtmlError("Microsoft Entra OIDC is not configured on this Worker.", 503);
  }
  const stateId = await createAuthorizeState(env, {
    clientId,
    redirectUri,
    clientState: state,
    codeChallenge,
    codeChallengeMethod,
    scope,
    resource,
  });
  return withOauthCors(request, Response.redirect(buildEntraAuthorizeUrl(config, stateId), 302));
}

export async function handleMicrosoftCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateId = url.searchParams.get("state") ?? "";
  const entraError = url.searchParams.get("error");
  const stored = stateId ? await consumeAuthorizeState(env, stateId) : null;
  if (!stored) {
    return oauthHtmlError("Authorization state is missing or expired. Restart the ChatGPT connection.", 400);
  }
  if (entraError || !code) {
    return redirectWithParams(env, stored.redirectUri, {
      error: entraError || "access_denied",
      error_description: url.searchParams.get("error_description") || "Microsoft sign-in was cancelled.",
      state: stored.clientState,
    });
  }
  try {
    const identity = await exchangeEntraAuthorizationCode(env, code);
    const authCode = await issueAuthorizationCode(env, {
      clientId: stored.clientId,
      redirectUri: stored.redirectUri,
      codeChallenge: stored.codeChallenge,
      codeChallengeMethod: stored.codeChallengeMethod,
      oid: identity.oid,
      email: identity.email,
      displayName: identity.name,
      resource: stored.resource,
      scope: stored.scope,
    });
    return redirectWithParams(env, stored.redirectUri, {
      code: authCode,
      state: stored.clientState,
    });
  } catch (error) {
    const description =
      error instanceof EntraOidcError || error instanceof OAuthRequestError
        ? error.message
        : "Microsoft identity validation failed.";
    return redirectWithParams(env, stored.redirectUri, {
      error: "access_denied",
      error_description: description,
      state: stored.clientState,
    });
  }
}

function redirectWithParams(
  env: Env,
  redirectUri: string,
  params: Record<string, string | null | undefined>
): Response {
  const target = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value) target.searchParams.set(key, value);
  }
  target.searchParams.set("iss", mcpIssuer(env));
  return Response.redirect(target.toString(), 302);
}

function authorizeError(
  env: Env,
  redirectUri: string,
  state: string | null,
  error: string,
  description: string
): Response {
  if (!redirectUri) return oauthHtmlError(description, 400);
  try {
    return redirectWithParams(env, redirectUri, { error, error_description: description, state });
  } catch {
    return oauthHtmlError(description, 400);
  }
}

function oauthHtmlError(message: string, status: number): Response {
  return new Response(`<!doctype html><html><body><p>${escapeHtml(message)}</p></body></html>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
