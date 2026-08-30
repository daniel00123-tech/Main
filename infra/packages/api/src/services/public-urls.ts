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

function isBrowserPublicHost(host: string): boolean {
  const hostname = host.toLowerCase();
  return (
    hostname === "app.infrastack.app" ||
    hostname.endsWith(".infrastack.app") ||
    hostname.endsWith(".infra-web.pages.dev")
  );
}

/**
 * Browser/ChatGPT-facing base. Prefer the portal origin so OAuth and MCP
 * stay first-party with the INFRA session cookie. Connector callbacks still
 * use infraPublicApiBase() / INFRA_PUBLIC_API_URL (workers.dev).
 */
export function infraBrowserPublicBase(
  env: Env,
  requestUrl?: string | URL | null,
  request?: Request | null,
): string {
  const forwardedHost = request?.headers.get("X-Forwarded-Host")?.split(",")[0]?.trim();
  const forwardedProto = request?.headers.get("X-Forwarded-Proto")?.split(",")[0]?.trim() || "https";
  if (forwardedHost && isBrowserPublicHost(forwardedHost)) {
    return `${forwardedProto}://${forwardedHost}`;
  }
  if (requestUrl) {
    try {
      const url = typeof requestUrl === "string" ? new URL(requestUrl) : requestUrl;
      if (isBrowserPublicHost(url.hostname)) {
        return url.origin;
      }
    } catch {
      /* fall through */
    }
  }
  return infraPublicApiBase(env, requestUrl);
}

export function oauthAuthorizeContinueUrl(
  env: Env,
  request: Request,
): string {
  const incoming = new URL(request.url);
  const browserBase = infraBrowserPublicBase(env, request.url, request);
  return `${browserBase}${incoming.pathname}${incoming.search}`;
}

/** Login URL used when /oauth/authorize has no INFRA session. */
export function oauthLoginRedirectUrl(env: Env, request: Request): string {
  const browserBase = infraBrowserPublicBase(env, request.url, request);
  const loginOrigin =
    browserBase.includes("infrastack.app") || browserBase.includes("pages.dev")
      ? browserBase
      : "https://app.infrastack.app";
  const login = new URL("/portal/login", `${loginOrigin}/`);
  login.searchParams.set("next", oauthAuthorizeContinueUrl(env, request));
  return login.toString();
}

export function infraMcpGatewayUrl(
  env: Env,
  requestUrl?: string | URL | null,
  request?: Request | null,
): string {
  return `${infraBrowserPublicBase(env, requestUrl, request)}/api/gateway/v1/mcp`;
}

export function infraGatewayExecuteUrl(env: Env, requestUrl?: string | URL | null): string {
  return `${infraPublicApiBase(env, requestUrl)}/api/gateway/v1/execute`;
}
