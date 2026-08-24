import { describe, expect, it } from "vitest";
import { checkMcpAuth } from "@business-mcp/core";

describe("HT MCP auth (fail-closed)", () => {
  const token = "ht-test-token-abc123";

  function request(authHeader?: string): Request {
    const headers = new Headers();
    if (authHeader !== undefined) {
      headers.set("Authorization", authHeader);
    }
    return new Request("https://example.com/mcp", { headers });
  }

  it("rejects when MCP_AUTH_TOKEN is missing", () => {
    expect(checkMcpAuth(request(), undefined, { requireToken: true })).toBe(false);
  });

  it("rejects missing Authorization header", () => {
    expect(checkMcpAuth(request(), token, { requireToken: true })).toBe(false);
  });

  it("rejects incorrect Bearer token", () => {
    expect(
      checkMcpAuth(request("Bearer wrong"), token, { requireToken: true })
    ).toBe(false);
  });

  it("accepts correct Bearer token", () => {
    expect(
      checkMcpAuth(request(`Bearer ${token}`), token, { requireToken: true })
    ).toBe(true);
  });
});
