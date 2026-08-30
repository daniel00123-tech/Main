import type { Env } from "../env";
import { handleAuthorize, handleMicrosoftCallback } from "./authorize";
import { oauthJson, oauthOptions, withOauthCors } from "./cors";
import { OAuthRequestError, dcrResponse, issuerForDcr, registerOAuthClient } from "./dcr";
import {
  oauthAuthorizationServerMetadata,
  oauthProtectedResourceMetadata,
  openIdConfiguration,
} from "./metadata";
import { handleRevoke, handleToken, handleUserinfo } from "./token";

export { gateMcpRequest, mcpOAuthUnauthorizedResponse } from "./mcp-auth";
export { verifyMcpAccessToken, issueMcpAccessToken } from "./jwt";
export { validateEntraIdToken, clearEntraJwksCache } from "./entra";
export { mcpPublicOrigin, mcpIssuer, mcpResourceUrl, loadMcpOAuthConfig } from "./config";

const WELL_KNOWN_PROTECTED = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
];
const WELL_KNOWN_AS = [
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/mcp",
];
const WELL_KNOWN_OIDC = [
  "/.well-known/openid-configuration",
  "/mcp/.well-known/openid-configuration",
];

export function isMcpOAuthPath(pathname: string): boolean {
  return (
    WELL_KNOWN_PROTECTED.includes(pathname) ||
    WELL_KNOWN_AS.includes(pathname) ||
    WELL_KNOWN_OIDC.includes(pathname) ||
    pathname === "/oauth/authorize" ||
    pathname === "/oauth/microsoft/callback" ||
    pathname === "/oauth/token" ||
    pathname === "/oauth/register" ||
    pathname === "/oauth/userinfo" ||
    pathname === "/oauth/revoke"
  );
}

export async function handleMcpOAuthRequest(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  if (request.method === "OPTIONS") return oauthOptions(request);

  if (WELL_KNOWN_PROTECTED.includes(url.pathname) && request.method === "GET") {
    return oauthJson(request, oauthProtectedResourceMetadata(env));
  }
  if (WELL_KNOWN_AS.includes(url.pathname) && request.method === "GET") {
    return oauthJson(request, oauthAuthorizationServerMetadata(env));
  }
  if (WELL_KNOWN_OIDC.includes(url.pathname) && request.method === "GET") {
    return oauthJson(request, openIdConfiguration(env));
  }
  if (url.pathname === "/oauth/register" && request.method === "POST") {
    try {
      const body = (await request.json()) as Record<string, unknown>;
      const { client, clientIdIssuedAt } = await registerOAuthClient(env, body);
      return oauthJson(request, dcrResponse(client, clientIdIssuedAt, issuerForDcr(env)), 201);
    } catch (error) {
      if (error instanceof OAuthRequestError) {
        return oauthJson(request, { error: error.error, error_description: error.message }, error.status);
      }
      return oauthJson(request, { error: "server_error", error_description: "Registration failed." }, 500);
    }
  }
  if (url.pathname === "/oauth/authorize" && request.method === "GET") {
    return withOauthCors(request, await handleAuthorize(request, env));
  }
  if (url.pathname === "/oauth/microsoft/callback" && request.method === "GET") {
    return handleMicrosoftCallback(request, env);
  }
  if (url.pathname === "/oauth/token" && request.method === "POST") {
    return handleToken(request, env);
  }
  if (url.pathname === "/oauth/userinfo" && (request.method === "GET" || request.method === "POST")) {
    return handleUserinfo(request, env);
  }
  if (url.pathname === "/oauth/revoke" && request.method === "POST") {
    return handleRevoke(request, env);
  }
  return oauthJson(request, { error: "not_found" }, 404);
}
