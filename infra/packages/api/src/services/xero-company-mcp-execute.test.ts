import { beforeEach, describe, expect, it, vi } from "vitest";

const listMcpEnvironments = vi.fn();
const executeRegisteredMcpTool = vi.fn();
const listMcpTools = vi.fn();

vi.mock("./control-plane", () => ({
  listMcpEnvironments: (...args: unknown[]) => listMcpEnvironments(...args),
  executeRegisteredMcpTool: (...args: unknown[]) => executeRegisteredMcpTool(...args),
}));

vi.mock("./mcp-client", () => ({
  listMcpTools: (...args: unknown[]) => listMcpTools(...args),
}));

import { executeCompanyMcpXeroRead } from "./xero-company-mcp";

const env = {
  DB: {
    prepare: () => ({
      bind: () => ({
        run: async () => ({ success: true }),
      }),
    }),
  },
} as never;

describe("executeCompanyMcpXeroRead live tool selection", () => {
  beforeEach(() => {
    listMcpEnvironments.mockReset();
    executeRegisteredMcpTool.mockReset();
    listMcpTools.mockReset();
    listMcpEnvironments.mockResolvedValue([
      {
        id: "mcp_el",
        enabled: true,
        endpointUrl: "https://el-business-mcp.example/mcp",
        authSecretRef: "EL_MCP_AUTH_TOKEN",
        serviceBindingRef: null,
      },
    ]);
    listMcpTools.mockResolvedValue({
      tools: [
        { name: "search_xero_invoices" },
        { name: "get_xero_invoice" },
        { name: "analyse_xero_sales" },
        { name: "create_xero_draft_invoice" },
      ],
    });
  });

  it("calls the live Elvex invoice search tool, not the INFRA facade name", async () => {
    executeRegisteredMcpTool.mockResolvedValue({
      status: 200,
      data: {
        result: {
          organisation: "Elvex Property Services Ltd",
          invoices: [{ InvoiceNumber: "INV-9", Type: "ACCREC", Status: "AUTHORISED", Total: 25 }],
        },
      },
    });

    const result = await executeCompanyMcpXeroRead(env, {
      companyId: "co_el",
      toolName: "xero_sales_summary",
      arguments: { fromDate: "2026-09-01", toDate: "2026-09-01" },
      actor: "william@elvexpropertyservices.com",
    });

    expect(result.ok).toBe(true);
    expect(executeRegisteredMcpTool).toHaveBeenCalledOnce();
    expect(executeRegisteredMcpTool.mock.calls[0][1]).toMatchObject({
      toolName: "search_xero_invoices",
      arguments: { from: "2026-09-01", to: "2026-09-01", top: 50 },
    });
    expect(executeRegisteredMcpTool.mock.calls[0][1].toolName).not.toBe("xero_sales_summary");
    if (result.ok) {
      expect(result.companyToolName).toBe("search_xero_invoices");
      expect(result.result.sales_total).toBe(25);
    }
  });

  it("does not treat an EL tool-error payload as a zero-sales result", async () => {
    executeRegisteredMcpTool.mockResolvedValue({
      status: 200,
      data: { result: { error: "token denied", code: "EL_XERO_TOKEN_DENIED" } },
    });

    const result = await executeCompanyMcpXeroRead(env, {
      companyId: "co_el",
      toolName: "xero_sales_summary",
      arguments: { fromDate: "2026-09-01", toDate: "2026-09-01" },
      actor: "william@elvexpropertyservices.com",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("I couldn’t retrieve Xero data just now.");
      expect(result.code).toBe("EL_XERO_TOKEN_DENIED");
    }
  });
});
