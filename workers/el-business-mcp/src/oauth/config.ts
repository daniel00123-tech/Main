import type { Env } from "../env";

export const DEFAULT_MCP_PUBLIC_ORIGIN = "https://el-business-mcp.infrastack.app";
export const DEFAULT_ELVEX_TENANT_ID = "af32e619-3647-44a2-85d9-1c45457c0e91";
export const ELVEX_COMPANY_ID = "co_el";
export const ELVEX_COMPANY_SLUG = "el-business";

export const MCP_OAUTH_SCOPES = ["openid", "email", "profile", "offline_access"] as const;
/** Retained only for leftover Entra token helpers. Not used for human MCP login. */
export const ENTRA_OIDC_SCOPES = "openid profile email offline_access";

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
export const AUTH_CODE_TTL_SECONDS = 10 * 60;
export const AUTHORIZE_STATE_TTL_SECONDS = 15 * 60;
export const CLOCK_SKEW_SECONDS = 60;

export type McpOAuthConfig = {
  publicOrigin: string;
  issuer: string;
  resource: string;
  tokenSecret: string;
  infraIssuer: string | null;
  tenantId: string;
  entraClientId: string;
  entraClientSecret: string;
  entraRedirectUri: string;
  entraIssuer: string;
  entraJwksUrl: string;
  entraAuthorizeUrl: string;
  entraTokenUrl: string;
};

export function mcpPublicOrigin(env: Env): string {
  const configured = env.EL_MCP_PUBLIC_ORIGIN?.trim().replace(/\/+$/, "");
  return configured || DEFAULT_MCP_PUBLIC_ORIGIN;
}

export function mcpResourceUrl(env: Env): string {
  return `${mcpPublicOrigin(env)}/mcp`;
}

export function infraOAuthIssuer(env: Env): string | null {
  const configured = (env.INFRA_OAUTH_ISSUER ?? env.INFRA_PUBLIC_API_URL)?.trim().replace(/\/+$/, "");
  return configured || null;
}

export function mcpIssuer(env: Env): string {
  return infraOAuthIssuer(env) || mcpPublicOrigin(env);
}

export function loadMcpOAuthConfig(env: Env): McpOAuthConfig | null {
  const publicOrigin = mcpPublicOrigin(env);
  const tokenSecret =
    (env.INFRA_MCP_OAUTH_SECRET ?? env.EL_MCP_TOKEN_SECRET ?? env.EL_RBAC_IDENTITY_SECRET)?.trim() ?? "";
  if (!tokenSecret) return null;
  const tenantId = env.EL_MS_TENANT_ID?.trim() || DEFAULT_ELVEX_TENANT_ID;
  const entraClientId = (env.EL_MS_OIDC_CLIENT_ID ?? env.EL_MS_CLIENT_ID)?.trim() ?? "";
  const entraClientSecret = (env.EL_MS_OIDC_CLIENT_SECRET ?? env.EL_MS_CLIENT_SECRET)?.trim() ?? "";
  const authority = `https://login.microsoftonline.com/${tenantId}`;
  return {
    publicOrigin,
    issuer: mcpIssuer(env),
    resource: `${publicOrigin}/mcp`,
    tokenSecret,
    infraIssuer: infraOAuthIssuer(env),
    tenantId,
    entraClientId,
    entraClientSecret,
    entraRedirectUri: env.EL_MS_OIDC_REDIRECT_URI?.trim() || `${publicOrigin}/oauth/microsoft/callback`,
    entraIssuer: `${authority}/v2.0`,
    entraJwksUrl: env.EL_MS_OIDC_JWKS_URL?.trim() || `${authority}/discovery/v2.0/keys`,
    entraAuthorizeUrl: `${authority}/oauth2/v2.0/authorize`,
    entraTokenUrl: `${authority}/oauth2/v2.0/token`,
  };
}

export function oauthReady(env: Env): boolean {
  return Boolean(loadMcpOAuthConfig(env)?.tokenSecret);
}

export function infraAuthorizeUrl(env: Env): string | null {
  const issuer = infraOAuthIssuer(env);
  return issuer ? `${issuer}/oauth/mcp/authorize` : null;
}

export function infraTokenUrl(env: Env): string | null {
  const issuer = infraOAuthIssuer(env);
  return issuer ? `${issuer}/oauth/mcp/token` : null;
}

export function infraRegisterUrl(env: Env): string | null {
  const issuer = infraOAuthIssuer(env);
  return issuer ? `${issuer}/oauth/mcp/register` : null;
}

export function infraIntrospectUrl(env: Env): string | null {
  const issuer = infraOAuthIssuer(env);
  return issuer ? `${issuer}/api/internal/mcp/introspect` : null;
}

export function infraUsageUrl(env: Env): string | null {
  const issuer = infraOAuthIssuer(env);
  return issuer ? `${issuer}/api/internal/mcp/usage` : null;
}
