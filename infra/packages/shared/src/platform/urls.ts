/**
 * Canonical and legacy INFRA production hostnames.
 *
 * Application code should import these constants (or env-backed helpers that
 * wrap them) instead of scattering production hostnames.
 *
 * Legacy workers.dev / pages.dev URLs stay valid during the cutover.
 */

export const INFRA_PUBLIC_ROOT = "https://infrastack.app";
export const INFRA_PORTAL_ORIGIN = "https://app.infrastack.app";
export const INFRA_API_ORIGIN = "https://api.infrastack.app";
export const INFRA_MCP_ORIGIN = "https://mcp.infrastack.app";
export const INFRA_MCP_PATH = "/api/gateway/v1/mcp";
export const INFRA_MCP_ENDPOINT = `${INFRA_MCP_ORIGIN}${INFRA_MCP_PATH}`;

export const LEGACY_PORTAL_ORIGIN = "https://infra-web.pages.dev";
export const LEGACY_PORTAL_BASE_DOMAIN = "infra-web.pages.dev";
export const LEGACY_API_ORIGIN = "https://infra-api.daniel-dwyer123.workers.dev";
export const LEGACY_MCP_ENDPOINT = `${LEGACY_API_ORIGIN}${INFRA_MCP_PATH}`;

export const XERO_OAUTH_CALLBACK_PATH = "/api/connectors/xero/oauth/callback";
export const MICROSOFT_OAUTH_CALLBACK_PATH = "/api/connectors/microsoft/oauth/callback";
export const GENERIC_OAUTH_CALLBACK_PATH = "/api/connectors/oauth/callback";
export const STRIPE_WEBHOOK_PATH = "/api/stripe/webhook";
export const MICROSOFT_GRAPH_WEBHOOK_PATH = "/api/webhooks/microsoft/graph";

export const XERO_CANONICAL_REDIRECT_URI = `${INFRA_API_ORIGIN}${XERO_OAUTH_CALLBACK_PATH}`;
export const XERO_LEGACY_REDIRECT_URI = `${LEGACY_API_ORIGIN}${XERO_OAUTH_CALLBACK_PATH}`;

export const MICROSOFT_CANONICAL_REDIRECT_URI = `${INFRA_API_ORIGIN}${MICROSOFT_OAUTH_CALLBACK_PATH}`;
export const MICROSOFT_LEGACY_REDIRECT_URI = `${LEGACY_API_ORIGIN}${MICROSOFT_OAUTH_CALLBACK_PATH}`;

export const STRIPE_CANONICAL_WEBHOOK_URL = `${INFRA_API_ORIGIN}${STRIPE_WEBHOOK_PATH}`;
export const STRIPE_LEGACY_WEBHOOK_URL = `${LEGACY_API_ORIGIN}${STRIPE_WEBHOOK_PATH}`;

export const MICROSOFT_CANONICAL_GRAPH_WEBHOOK_URL = `${INFRA_API_ORIGIN}${MICROSOFT_GRAPH_WEBHOOK_PATH}`;
export const MICROSOFT_LEGACY_GRAPH_WEBHOOK_URL = `${LEGACY_API_ORIGIN}${MICROSOFT_GRAPH_WEBHOOK_PATH}`;

/** Apex + portal hosts that must never be treated as a company subdomain. */
const RESERVED_PRODUCTION_HOSTS = new Set([
  "infrastack.app",
  "www.infrastack.app",
  "app.infrastack.app",
  "api.infrastack.app",
  "mcp.infrastack.app",
  "infra-web.pages.dev",
]);

export function hostnameOf(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = value.includes("://") ? new URL(value) : new URL(`https://${value}`);
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isReservedProductionHost(hostname: string | null | undefined): boolean {
  if (!hostname) return false;
  return RESERVED_PRODUCTION_HOSTS.has(hostname.toLowerCase());
}

export function isLegacyPagesDevHost(hostname: string | null | undefined): boolean {
  if (!hostname) return false;
  const host = hostname.toLowerCase();
  return host === LEGACY_PORTAL_BASE_DOMAIN || host.endsWith(`.${LEGACY_PORTAL_BASE_DOMAIN}`);
}

export function isCanonicalPortalHost(hostname: string | null | undefined): boolean {
  return hostname?.toLowerCase() === "app.infrastack.app";
}

/**
 * Host-only cookies on app.infrastack.app.
 * Domain=.infra-web.pages.dev only for the temporary company-subdomain fallback.
 * Never set Domain=.infrastack.app.
 */
export function sessionCookieDomainForHost(hostname: string | null | undefined): string | null {
  if (isLegacyPagesDevHost(hostname)) return `.${LEGACY_PORTAL_BASE_DOMAIN}`;
  return null;
}
