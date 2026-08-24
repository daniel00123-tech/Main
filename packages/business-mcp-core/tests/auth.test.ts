import { describe, expect, it } from "vitest";
import {
  checkMcpAuth,
  assertMcpAuth,
} from "../src/auth/mcp-auth";
import { UnauthorizedError } from "../src/types/errors";

describe("MCP auth", () => {
  it("allows requests when token unset and requireToken false", () => {
    const request = new Request("https://example.com/mcp");
    expect(checkMcpAuth(request, undefined)).toBe(true);
  });

  it("rejects requests when token unset and requireToken true", () => {
    const request = new Request("https://example.com/mcp");
    expect(checkMcpAuth(request, undefined, { requireToken: true })).toBe(
      false
    );
  });

  it("accepts valid bearer token", () => {
    const request = new Request("https://example.com/mcp", {
      headers: { Authorization: "Bearer secret-token" },
    });
    expect(checkMcpAuth(request, "secret-token")).toBe(true);
  });

  it("rejects invalid bearer token", () => {
    const request = new Request("https://example.com/mcp", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(checkMcpAuth(request, "secret-token")).toBe(false);
  });

  it("assertMcpAuth throws UnauthorizedError when fail closed", () => {
    const request = new Request("https://example.com/mcp");
    expect(() =>
      assertMcpAuth(request, undefined, { requireToken: true })
    ).toThrow(UnauthorizedError);
  });
});
