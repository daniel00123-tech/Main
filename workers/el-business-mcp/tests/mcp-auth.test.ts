import { describe, expect, it } from "vitest";
import { checkMcpAuth } from "@business-mcp/core";

describe("EL MCP auth fail-closed", () => {
  it("rejects when token is missing and requireToken is true", () => {
    const request = new Request("https://example.com/mcp");
    expect(checkMcpAuth(request, undefined, { requireToken: true })).toBe(false);
  });

  it("accepts valid bearer token", () => {
    const request = new Request("https://example.com/mcp", {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(checkMcpAuth(request, "test-token", { requireToken: true })).toBe(true);
  });
});
