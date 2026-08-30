import type { Env } from "../env";
import {
  MCP_OAUTH_SCOPES,
  infraOAuthIssuer,
  loadMcpOAuthConfig,
  mcpIssuer,
  mcpPublicOrigin,
  mcpResourceUrl,
} from "./config";

export function oauthProtectedResourceMetadata(env: Env): Record<string, unknown> {
  const origin = mcpPublicOrigin(env);
  const infra = infraOAuthIssuer(env);
  return {
    resource: mcpResourceUrl(env),
    authorization_servers: infra ? [infra, origin] : [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: [...MCP_OAUTH_SCOPES],
    resource_documentation: `${origin}/status`,
  };
}

export function oauthAuthorizationServerMetadata(env: Env): Record<string, unknown> {
  const origin = mcpPublicOrigin(env);
  const infra = infraOAuthIssuer(env);
  const issuer = mcpIssuer(env);
  const authorize = infra ? `${infra}/oauth/mcp/authorize` : `${origin}/oauth/authorize`;
  const token = infra ? `${infra}/oauth/mcp/token` : `${origin}/oauth/token`;
  const register = infra ? `${infra}/oauth/mcp/register` : `${origin}/oauth/register`;
  const userinfo = infra ? `${infra}/oauth/mcp/userinfo` : `${origin}/oauth/userinfo`;
  const revoke = infra ? `${infra}/oauth/mcp/revoke` : `${origin}/oauth/revoke`;
  return {
    issuer,
    authorization_endpoint: authorize,
    token_endpoint: token,
    registration_endpoint: register,
    userinfo_endpoint: userinfo,
    revocation_endpoint: revoke,
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
      "ChatGPT custom MCP app: choose OAuth. Employees authenticate with their existing INFRA company account. Microsoft 365 is a downstream data connector only.",
  };
}

export function openIdConfiguration(env: Env): Record<string, unknown> {
  const infra = infraOAuthIssuer(env);
  const origin = mcpPublicOrigin(env);
  return {
    ...oauthAuthorizationServerMetadata(env),
    userinfo_endpoint: infra ? `${infra}/oauth/mcp/userinfo` : `${origin}/oauth/userinfo`,
    claims_supported: ["sub", "email", "name", "company_id", "company_slug", "client"],
  };
}

export function oauthMetadataStatus(env: Env): Record<string, unknown> {
  const config = loadMcpOAuthConfig(env);
  return {
    oauth: {
      configured: Boolean(config),
      issuer: mcpIssuer(env),
      resource: mcpResourceUrl(env),
      infraIssuer: config?.infraIssuer ?? null,
      identityAuthority: "infra",
      tokenSigningConfigured: Boolean(config?.tokenSecret),
    },
  };
}
