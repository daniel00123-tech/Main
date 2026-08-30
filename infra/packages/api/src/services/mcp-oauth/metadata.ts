import type { Env } from "../../env";
import { infraMcpGatewayUrl, infraPublicApiBase, portalOrigin } from "../public-urls";
import { MCP_OAUTH_SCOPES } from "./types";
import { mcpOAuthIssuer } from "./tokens";

export function mcpOAuthAuthorizationServerMetadata(
  env: Env,
  requestUrl?: string | URL | null,
): Record<string, unknown> {
  const issuer = mcpOAuthIssuer(env, requestUrl);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/mcp/authorize`,
    token_endpoint: `${issuer}/oauth/mcp/token`,
    registration_endpoint: `${issuer}/oauth/mcp/register`,
    userinfo_endpoint: `${issuer}/oauth/mcp/userinfo`,
    revocation_endpoint: `${issuer}/oauth/mcp/revoke`,
    introspection_endpoint: `${issuer}/api/internal/mcp/introspect`,
    scopes_supported: [...MCP_OAUTH_SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["HS256"],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
    require_pkce: true,
    service_documentation:
      "ChatGPT custom MCP: choose OAuth. Employees sign in with their existing INFRA company account. Microsoft 365 is a downstream data connector only.",
  };
}

export function mcpOAuthProtectedResourceMetadata(
  env: Env,
  requestUrl?: string | URL | null,
): Record<string, unknown> {
  const issuer = mcpOAuthIssuer(env, requestUrl);
  return {
    resource: infraMcpGatewayUrl(env, requestUrl),
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: [...MCP_OAUTH_SCOPES],
    resource_documentation: portalOrigin(env),
  };
}

export function mcpOAuthOpenIdConfiguration(
  env: Env,
  requestUrl?: string | URL | null,
): Record<string, unknown> {
  return {
    ...mcpOAuthAuthorizationServerMetadata(env, requestUrl),
    claims_supported: ["sub", "email", "name", "company_id", "company_slug", "client"],
  };
}

export function mcpOAuthPublicUrls(env: Env, requestUrl?: string | URL | null) {
  const issuer = infraPublicApiBase(env, requestUrl);
  return {
    issuer,
    authorizationEndpoint: `${issuer}/oauth/mcp/authorize`,
    tokenEndpoint: `${issuer}/oauth/mcp/token`,
    registrationEndpoint: `${issuer}/oauth/mcp/register`,
    userinfoEndpoint: `${issuer}/oauth/mcp/userinfo`,
    revocationEndpoint: `${issuer}/oauth/mcp/revoke`,
    mcpEndpoint: infraMcpGatewayUrl(env, requestUrl),
  };
}
