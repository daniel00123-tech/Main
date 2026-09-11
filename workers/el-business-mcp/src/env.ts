export interface Env {
  EL_BUSINESS_DATA: D1Database;
  /** Required in production — MCP fails closed when missing. */
  MCP_AUTH_TOKEN?: string;
  /** Required for /admin and /status admin-protected routes. */
  EL_ADMIN_TOKEN?: string;
}
