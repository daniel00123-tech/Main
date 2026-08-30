export interface Env {
  EL_BUSINESS_DATA: D1Database;
  /** Required in production — MCP fails closed when missing. */
  MCP_AUTH_TOKEN?: string;
  /** Required for /admin and /status admin-protected routes. */
  EL_ADMIN_TOKEN?: string;
  /** HMAC secret for signed INFRA → EL identity headers. Privileged MCP tools fail closed without it. */
  EL_RBAC_IDENTITY_SECRET?: string;
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
