export const MCP_ACCESS_TYP = "infra_mcp_access";
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
export const AUTH_CODE_TTL_SECONDS = 10 * 60;
export const CLOCK_SKEW_SECONDS = 60;

export const MCP_OAUTH_SCOPES = ["openid", "email", "profile", "offline_access"] as const;

export const AI_CLIENT_TYPES = ["chatgpt", "claude", "whatsapp"] as const;
export type AiClientType = (typeof AI_CLIENT_TYPES)[number];

export type InfraMcpAccessClaims = {
  iss: string;
  aud: string;
  sub: string;
  company_id: string;
  company_slug: string;
  client: string;
  client_id?: string;
  email?: string;
  name?: string;
  typ: typeof MCP_ACCESS_TYP;
  jti: string;
  iat: number;
  nbf: number;
  exp: number;
  scope?: string;
};

export type LiveMcpPrincipal = {
  userId: string;
  email: string;
  displayName: string;
  companyId: string;
  companySlug: string;
  companyName: string;
  role: string;
  client: string;
};

export type McpOAuthClient = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none" | "client_secret_post";
  clientSecretHash: string | null;
};

export function normalizeAiClient(value: string | null | undefined): AiClientType {
  const raw = (value ?? "").trim().toLowerCase();
  if (raw === "claude") return "claude";
  if (raw === "whatsapp") return "whatsapp";
  return "chatgpt";
}
