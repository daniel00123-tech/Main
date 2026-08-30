import type { Env } from "../env";

export const DEFAULT_MCP_PUBLIC_ORIGIN = "https://el-business-mcp.infrastack.app";
export const DEFAULT_ELVEX_TENANT_ID = "af32e619-3647-44a2-85d9-1c45457c0e91";

export const MCP_OAUTH_SCOPES = ["openid", "email", "profile", "offline_access"] as const;
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
  tenantId: string;
  entraClientId: string;
  entraClientSecret: string;
  entraRedirectUri: string;
  entraIssuer: string;
  entraJwksUrl: string;
  entraAuthorizeUrl: string;
  entraTokenUrl: string;
  tokenSecret: string;
};

export function mcpPublicOrigin(env: Env): string {
  const configured = env.EL_MCP_PUBLIC_ORIGIN?.trim().replace(/\/+$/, "");
  return configured || DEFAULT_MCP_PUBLIC_ORIGIN;
}

export function mcpResourceUrl(env: Env): string {
  return `${mcpPublicOrigin(env)}/mcp`;
}

export function mcpIssuer(env: Env): string {
  return mcpPublicOrigin(env);
}

export function loadMcpOAuthConfig(env: Env): McpOAuthConfig | null {
  const publicOrigin = mcpPublicOrigin(env);
  const tenantId = env.EL_MS_TENANT_ID?.trim() || DEFAULT_ELVEX_TENANT_ID;
  const entraClientId = (env.EL_MS_OIDC_CLIENT_ID ?? env.EL_MS_CLIENT_ID)?.trim() ?? "";
  const entraClientSecret = (env.EL_MS_OIDC_CLIENT_SECRET ?? env.EL_MS_CLIENT_SECRET)?.trim() ?? "";
  const tokenSecret = (env.EL_MCP_TOKEN_SECRET ?? env.EL_RBAC_IDENTITY_SECRET)?.trim() ?? "";
  if (!entraClientId || !tokenSecret) return null;
  const entraRedirectUri =
    env.EL_MS_OIDC_REDIRECT_URI?.trim() || `${publicOrigin}/oauth/microsoft/callback`;
  const authority = `https://login.microsoftonline.com/${tenantId}`;
  return {
    publicOrigin,
    issuer: publicOrigin,
    resource: `${publicOrigin}/mcp`,
    tenantId,
    entraClientId,
    entraClientSecret,
    entraRedirectUri,
    entraIssuer: `${authority}/v2.0`,
    entraJwksUrl:
      env.EL_MS_OIDC_JWKS_URL?.trim() || `${authority}/discovery/v2.0/keys`,
    entraAuthorizeUrl: `${authority}/oauth2/v2.0/authorize`,
    entraTokenUrl: `${authority}/oauth2/v2.0/token`,
    tokenSecret,
  };
}

export function oauthReady(env: Env): boolean {
  const config = loadMcpOAuthConfig(env);
  return Boolean(config?.entraClientId && config.tokenSecret);
}
