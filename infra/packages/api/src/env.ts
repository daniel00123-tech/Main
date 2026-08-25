export interface Env {
  DB: D1Database;
  ENVIRONMENT: string;
  SESSION_SECRET: string;
  ALLOWED_ORIGINS: string;
  COOKIE_CROSS_ORIGIN?: string;
  INITIAL_PLATFORM_ADMIN_EMAIL?: string;
  INITIAL_PLATFORM_ADMIN_PASSWORD?: string;
  /** Optional MCP auth secret referenced by mcp_environments.auth_secret_ref */
  CADDINGTON_MCP_AUTH_TOKEN?: string;
  HT_MCP_AUTH_TOKEN?: string;
  EL_MCP_AUTH_TOKEN?: string;
  /** Optional service bindings for same-account company MCP Workers */
  CADDINGTON_MCP?: Fetcher;
  HT_BUSINESS_MCP?: Fetcher;
  EL_BUSINESS_MCP?: Fetcher;
  /** Stripe secrets — set via wrangler secret put when ready */
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** Public API base URL for gateway/MCP endpoints returned to clients (no trailing slash) */
  INFRA_PUBLIC_API_URL?: string;
  /** Portal host domain for subdomain routing, e.g. infra-web.pages.dev */
  PORTAL_BASE_DOMAIN?: string;
  /** Envelope-encryption wrapping key for connector credentials. Never store in D1. */
  INFRA_CREDENTIAL_WRAPPING_KEY?: string;
  INFRA_CREDENTIAL_KEY_VERSION?: string;
  [key: string]: unknown;
}

export function parseAllowedOrigins(value: string): string[] {
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) return false;
  return allowedOrigins.includes(origin);
}
