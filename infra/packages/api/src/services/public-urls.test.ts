import { describe, expect, it } from "vitest";
import {
  INFRA_API_ORIGIN,
  INFRA_PORTAL_ORIGIN,
  LEGACY_API_ORIGIN,
} from "@infra/shared";
import {
  infraMcpGatewayUrl,
  infraPublicApiBase,
  oauthAuthorizeContinuePath,
  oauthLoginRedirectUrl,
  portalOrigin,
} from "./public-urls";
import type { Env } from "../env";

function env(overrides: Partial<Env> = {}): Env {
  return {
    ALLOWED_ORIGINS: "https://app.infrastack.app",
    ...overrides,
  } as Env;
}

describe("public URLs", () => {
  it("defaults to canonical production hosts", () => {
    expect(infraPublicApiBase(env())).toBe(INFRA_API_ORIGIN);
    // ChatGPT/OAuth first-party resource is the API (or portal) host, not mcp.infrastack.app.
    expect(infraMcpGatewayUrl(env())).toBe(`${INFRA_API_ORIGIN}/api/gateway/v1/mcp`);
    expect(portalOrigin(env())).toBe(INFRA_PORTAL_ORIGIN);
  });

  it("prefers env overrides and request origin for portal links", () => {
    const configured = env({
      INFRA_PUBLIC_API_URL: LEGACY_API_ORIGIN,
      INFRA_PUBLIC_MCP_URL: "https://mcp.infrastack.app",
      PORTAL_PUBLIC_ORIGIN: INFRA_PORTAL_ORIGIN,
    });
    expect(infraPublicApiBase(configured)).toBe(LEGACY_API_ORIGIN);
    expect(portalOrigin(configured, "https://infra-web.pages.dev")).toBe(
      "https://infra-web.pages.dev",
    );
  });

  it("keeps OAuth login and continue on the portal, never api/workers.dev", () => {
    const configured = env({
      INFRA_PUBLIC_API_URL: LEGACY_API_ORIGIN,
      PORTAL_PUBLIC_ORIGIN: INFRA_PORTAL_ORIGIN,
    });
    const authorize =
      "https://infra-api.daniel-dwyer123.workers.dev/oauth/authorize?response_type=code&client_id=chatgpt-mcp&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fconnector%2Foauth%2FoVPk3&code_challenge=abc&code_challenge_method=S256";
    const request = new Request(authorize);
    expect(oauthAuthorizeContinuePath(request)).toBe(
      "/oauth/authorize?response_type=code&client_id=chatgpt-mcp&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fconnector%2Foauth%2FoVPk3&code_challenge=abc&code_challenge_method=S256",
    );
    const login = oauthLoginRedirectUrl(configured, request);
    expect(login.startsWith("https://app.infrastack.app/portal/login?")).toBe(true);
    expect(login).not.toContain("workers.dev");
    expect(login).not.toContain("api.infrastack.app");
    expect(login).toContain("next=%2Foauth%2Fauthorize");

    const proxied = new Request(authorize, {
      headers: { "X-Forwarded-Host": "app.infrastack.app", "X-Forwarded-Proto": "https" },
    });
    const proxiedLogin = oauthLoginRedirectUrl(configured, proxied);
    expect(proxiedLogin.startsWith("https://app.infrastack.app/portal/login?")).toBe(true);
    expect(proxiedLogin).toContain("next=%2Foauth%2Fauthorize");
  });
});
