import type { Env } from "../env";

const DEFAULT_PORTAL_BASE_DOMAIN = "infra-web.pages.dev";

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
  return "https://infra-api.daniel-dwyer123.workers.dev";
}

export function portalBaseDomain(env: Env): string {
  return env.PORTAL_BASE_DOMAIN?.trim() || DEFAULT_PORTAL_BASE_DOMAIN;
}

export function portalOrigin(env: Env, requestOrigin?: string | null): string {
  if (requestOrigin?.trim()) return requestOrigin.trim().replace(/\/$/, "");
  return `https://${portalBaseDomain(env)}`;
}

export function portalHostForSubdomain(env: Env, subdomain: string): string {
  return `${subdomain}.${portalBaseDomain(env)}`;
}

export function infraMcpGatewayUrl(env: Env, requestUrl?: string | URL | null): string {
  return `${infraPublicApiBase(env, requestUrl)}/api/gateway/v1/mcp`;
}

export function infraGatewayExecuteUrl(env: Env, requestUrl?: string | URL | null): string {
  return `${infraPublicApiBase(env, requestUrl)}/api/gateway/v1/execute`;
}
