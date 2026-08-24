import { describe, expect, it } from "vitest";
import { validateRegisteredMcpEndpoint } from "../services/control-plane";

describe("validateRegisteredMcpEndpoint", () => {
  it("accepts public https endpoints", () => {
    const result = validateRegisteredMcpEndpoint(
      "https://mcp.example.com/mcp",
      "production",
    );
    expect(result.valid).toBe(true);
  });

  it("rejects localhost endpoints in production", () => {
    const result = validateRegisteredMcpEndpoint(
      "http://localhost:8787/mcp",
      "production",
    );
    expect(result.valid).toBe(false);
  });

  it("rejects private network hosts", () => {
    const result = validateRegisteredMcpEndpoint(
      "https://192.168.0.10/mcp",
      "production",
    );
    expect(result.valid).toBe(false);
  });

  it("rejects unsupported protocols", () => {
    const result = validateRegisteredMcpEndpoint("ftp://example.com/mcp", "development");
    expect(result.valid).toBe(false);
  });
});
