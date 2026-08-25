import { describe, expect, it, vi } from "vitest";
import { fetchInfraXeroContext } from "./register";

describe("fetchInfraXeroContext", () => {
  it("fails truthfully when bridge auth is missing", async () => {
    const result = await fetchInfraXeroContext({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("XERO_BRIDGE_NOT_CONFIGURED");
    }
  });

  it("never returns tokens in error paths", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({ error: "Permission denied", code: "CONNECTOR_PERMISSION_DENIED" }, {
        status: 401,
      }),
    ) as typeof fetch;
    const result = await fetchInfraXeroContext({
      MCP_AUTH_TOKEN: "test-token",
      INFRA_API_URL: "https://infra-api.example",
      INFRA_MCP_ENVIRONMENT_ID: "mcp_test",
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/accessToken|refresh/i);
  });
});
