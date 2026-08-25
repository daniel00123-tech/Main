import { describe, expect, it } from "vitest";
import { resolveXeroMcpExecutionContext } from "./xero-mcp-bridge";

describe("xero MCP bridge", () => {
  it("rejects bridge calls without bearer token", async () => {
    class FakeD1 {
      prepare() {
        return {
          bind: () => ({
            first: async () => null,
            all: async () => ({ results: [] }),
          }),
        };
      }
    }
    const env = { DB: new FakeD1() } as never;
    const result = await resolveXeroMcpExecutionContext({
      env,
      companyId: "co_caddington",
      mcpEnvironmentId: "mcp_caddington_primary",
      authHeader: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect([401, 404]).toContain(result.status);
      expect(JSON.stringify(result.body)).not.toMatch(/accessToken|secret/i);
    }
  });
});
