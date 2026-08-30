export interface Env {
  EL_BUSINESS_DATA: D1Database;
  /** Required in production — MCP fails closed when missing. */
  MCP_AUTH_TOKEN?: string;
  /** Required for /admin and /status admin-protected routes. */
  EL_ADMIN_TOKEN?: string;
  /** HMAC secret for signed INFRA → EL identity headers. Privileged MCP tools fail closed without it. */
  EL_RBAC_IDENTITY_SECRET?: string;
  /** Public origin advertised in OAuth/OIDC metadata. Defaults to the custom domain. */
  EL_MCP_PUBLIC_ORIGIN?: string;
  /** HS256 secret for verifying INFRA MCP access tokens. Falls back to EL_RBAC_IDENTITY_SECRET. */
  EL_MCP_TOKEN_SECRET?: string;
  /** Same value as INFRA MCP_OAUTH_SECRET when tokens are verified locally. */
  INFRA_MCP_OAUTH_SECRET?: string;
  /** INFRA public API origin — OAuth AS, introspect, and usage reporting. */
  INFRA_PUBLIC_API_URL?: string;
  INFRA_OAUTH_ISSUER?: string;
  INFRA_MCP_INTERNAL_SECRET?: string;
  /** Optional dedicated Entra OIDC web app. Falls back to EL_MS_CLIENT_ID / EL_MS_CLIENT_SECRET. */
  EL_MS_OIDC_CLIENT_ID?: string;
  EL_MS_OIDC_CLIENT_SECRET?: string;
  EL_MS_OIDC_REDIRECT_URI?: string;
  /** Test-only JWKS override for Entra ID token validation. */
  EL_MS_OIDC_JWKS_URL?: string;
  /** Elvex Microsoft Entra tenant (plain var, already on Worker). */
  EL_MS_TENANT_ID?: string;
  EL_MS_CLIENT_ID?: string;
  EL_MS_CLIENT_SECRET?: string;
  /** Comma-separated approved shared mailboxes. */
  EL_MS_APPROVED_MAILBOXES?: string;
  /** Comma-separated calendar mailboxes (defaults to approved mailboxes). */
  EL_MS_CALENDAR_MAILBOXES?: string;
  /** Comma-separated protected user hints (names or emails). */
  EL_MS_PROTECTED_USERS?: string;
  EL_MS_SHAREPOINT_HOSTNAME?: string;
  EL_MS_GRAPH_BASE_URL?: string;
  EL_MS_MAIL_DOMAIN?: string;
  EL_XERO_CLIENT_ID?: string;
  EL_XERO_CLIENT_SECRET?: string;
  EL_XERO_REDIRECT_URI?: string;
  EL_XERO_EXPECTED_ORG?: string;
}
