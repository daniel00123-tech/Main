import { describe, expect, it } from "vitest";
import {
  INFRA_MCP_ENDPOINT,
  INFRA_PORTAL_ORIGIN,
  XERO_CANONICAL_REDIRECT_URI,
  XERO_LEGACY_REDIRECT_URI,
  isReservedProductionHost,
  sessionCookieDomainForHost,
} from "./urls";

describe("production URLs", () => {
  it("exposes canonical MCP and portal hosts", () => {
    expect(INFRA_PORTAL_ORIGIN).toBe("https://app.infrastack.app");
    expect(INFRA_MCP_ENDPOINT).toBe("https://mcp.infrastack.app/api/gateway/v1/mcp");
  });

  it("keeps both Xero callback URIs", () => {
    expect(XERO_CANONICAL_REDIRECT_URI).toBe(
      "https://api.infrastack.app/api/connectors/xero/oauth/callback",
    );
    expect(XERO_LEGACY_REDIRECT_URI).toBe(
      "https://infra-api.daniel-dwyer123.workers.dev/api/connectors/xero/oauth/callback",
    );
  });

  it("does not treat reserved hosts as company subdomains", () => {
    expect(isReservedProductionHost("app.infrastack.app")).toBe(true);
    expect(isReservedProductionHost("caddington.infra-web.pages.dev")).toBe(false);
  });

  it("uses host-only cookies on app.infrastack.app", () => {
    expect(sessionCookieDomainForHost("app.infrastack.app")).toBeNull();
    expect(sessionCookieDomainForHost("infra-web.pages.dev")).toBe(".infra-web.pages.dev");
    expect(sessionCookieDomainForHost("caddington.infra-web.pages.dev")).toBe(
      ".infra-web.pages.dev",
    );
  });
});
