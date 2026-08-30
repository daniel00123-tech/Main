import { describe, expect, it } from "vitest";
import {
  INFRA_API_ORIGIN,
  INFRA_PORTAL_ORIGIN,
  LEGACY_API_ORIGIN,
} from "@infra/shared";
import {
  infraMcpGatewayUrl,
  infraPublicApiBase,
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
});
