import { describe, expect, it } from "vitest";
import { checkMcpAuth } from "@business-mcp/core";
import { isMcpDiscoveryMethod } from "../src/oauth/mcp-auth";

describe("EL MCP auth fail-closed", () => {
  it("rejects when token is missing and requireToken is true", () => {
    const request = new Request("https://example.com/mcp");
    expect(checkMcpAuth(request, undefined, { requireToken: true })).toBe(false);
  });

  it("accepts valid bearer token for machine/service transport", () => {
    const request = new Request("https://example.com/mcp", {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(checkMcpAuth(request, "test-token", { requireToken: true })).toBe(true);
  });

  it("treats tools/list as discovery and tools/call as privileged", () => {
    expect(isMcpDiscoveryMethod("tools/list")).toBe(true);
    expect(isMcpDiscoveryMethod("initialize")).toBe(true);
    expect(isMcpDiscoveryMethod("tools/call")).toBe(false);
  });
});
