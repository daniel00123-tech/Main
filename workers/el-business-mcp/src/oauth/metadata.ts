import type { Env } from "../env";
import { MCP_OAUTH_SCOPES, loadMcpOAuthConfig, mcpIssuer, mcpPublicOrigin, mcpResourceUrl } from "./config";

export function oauthProtectedResourceMetadata(env: Env): Record<string, unknown> {
  const origin = mcpPublicOrigin(env);
  return {
    resource: mcpResourceUrl(env),
    authorization_servers: [mcpIssuer(env)],
    bearer_methods_supported: ["header"],
    scopes_supported: [...MCP_OAUTH_SCOPES],
    resource_documentation: `${origin}/status`,
  };
}

export function oauthAuthorizationServerMetadata(env: Env): Record<string, unknown> {
  const origin = mcpPublicOrigin(env);
  const issuer = mcpIssuer(env);
  return {
    issuer,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    userinfo_endpoint: `${origin}/oauth/userinfo`,
    revocation_endpoint: `${origin}/oauth/revoke`,
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
      "ChatGPT custom MCP app: choose OAuth. Discovery uses this authorization server. Employees sign in with Microsoft Entra ID.",
  };
}

export function openIdConfiguration(env: Env): Record<string, unknown> {
  return {
    ...oauthAuthorizationServerMetadata(env),
    userinfo_endpoint: `${mcpPublicOrigin(env)}/oauth/userinfo`,
    claims_supported: ["sub", "oid", "email", "name", "email_verified"],
  };
}

export function oauthMetadataStatus(env: Env): Record<string, unknown> {
  const config = loadMcpOAuthConfig(env);
  return {
    oauth: {
      configured: Boolean(config),
      issuer: mcpIssuer(env),
      resource: mcpResourceUrl(env),
      entraTenantConfigured: Boolean(config?.tenantId),
      entraClientConfigured: Boolean(config?.entraClientId),
      entraSecretConfigured: Boolean(config?.entraClientSecret),
      tokenSigningConfigured: Boolean(config?.tokenSecret),
    },
  };
}
