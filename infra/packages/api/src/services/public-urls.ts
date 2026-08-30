import type { Env } from "../env";
import {
  INFRA_API_ORIGIN,
  INFRA_MCP_ENDPOINT,
  INFRA_MCP_ORIGIN,
  INFRA_MCP_PATH,
  INFRA_PORTAL_ORIGIN,
  LEGACY_API_ORIGIN,
  LEGACY_PORTAL_BASE_DOMAIN,
  hostnameOf,
  isReservedProductionHost,
} from "@infra/shared";

/** Derive the public INFRA API base URL (no trailing slash). */
export function infraPublicApiBase(env: Env, requestUrl?: string | URL | null): string {
  const fromEnv = env.INFRA_PUBLIC_API_URL?.trim().replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  if (requestUrl) {
    try {
      const url = typeof requestUrl === "string" ? new URL(requestUrl) : requestUrl;
      return url.origin;
    } catch {
      /* fall through */
    }
  }
  return INFRA_API_ORIGIN;
}

export function infraPublicMcpOrigin(env: Env): string {
  const fromEnv = env.INFRA_PUBLIC_MCP_URL?.trim().replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  return INFRA_MCP_ORIGIN;
}

export function portalBaseDomain(env: Env): string {
  return env.PORTAL_BASE_DOMAIN?.trim() || LEGACY_PORTAL_BASE_DOMAIN;
}

export function portalOrigin(env: Env, requestOrigin?: string | null): string {
  if (requestOrigin?.trim()) {
    try {
      return new URL(requestOrigin.trim()).origin;
    } catch {
      return requestOrigin.trim().replace(/\/$/, "");
    }
  }
  const fromEnv = env.PORTAL_PUBLIC_ORIGIN?.trim().replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  return INFRA_PORTAL_ORIGIN;
}

export function portalHostForSubdomain(env: Env, subdomain: string): string {
  return `${subdomain}.${portalBaseDomain(env)}`;
}

export function infraMcpGatewayUrl(env: Env, _requestUrl?: string | URL | null): string {
  return `${infraPublicMcpOrigin(env)}${INFRA_MCP_PATH}`;
}

export function infraGatewayExecuteUrl(env: Env, requestUrl?: string | URL | null): string {
  return `${infraPublicApiBase(env, requestUrl)}/api/gateway/v1/execute`;
}

export { INFRA_MCP_ENDPOINT, LEGACY_API_ORIGIN };

export function isCompanyPortalHostname(hostname: string | null | undefined): boolean {
  const host = hostnameOf(hostname);
  if (!host || isReservedProductionHost(host)) return false;
  return host.split(".").length >= 3;
}
