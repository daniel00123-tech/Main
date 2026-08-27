import { describe, expect, it, vi } from "vitest";
import { fetchInfraXeroContext, registerXeroReadTools, registerXeroWriteTools } from "./register";

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

describe("registerXeroTools", () => {
  it("registers all read and write tools without duplicate names", () => {
    const server = createMockServer();
    registerXeroReadTools(server, {}, z);
    registerXeroWriteTools(server, {}, z);
    const names = server.tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("xero_get_organisation");
    expect(names).toContain("xero_profit_and_loss");
    expect(names).toContain("xero_sales_summary");
    expect(names).toContain("xero_create_draft_invoice");
  });
});

function createMockServer() {
  const tools: Array<{ name: string }> = [];
  return {
    tools,
    registerTool(name: string) {
      tools.push({ name });
    },
  };
}

const z = {
  string: () => ({
    min: () => chain(),
    optional: () => chain(),
    describe: () => chain(),
  }),
  number: () => ({
    int: () => ({
      min: () => ({
        max: () => chain(),
        optional: () => chain(),
        describe: () => chain(),
      }),
      min: () => chain(),
      optional: () => chain(),
      describe: () => chain(),
    }),
    optional: () => chain(),
    describe: () => chain(),
    min: () => chain(),
  }),
  boolean: () => ({ optional: () => chain() }),
  object: (shape: Record<string, unknown>) => shape,
  array: (_schema: unknown) => ({
    min: () => chain(),
    optional: () => chain(),
  }),
};

function chain() {
  const api = {
    min: () => api,
    max: () => api,
    optional: () => api,
    describe: () => api,
  };
  return api;
}
