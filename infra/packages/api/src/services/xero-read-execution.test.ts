import { beforeEach, describe, expect, it, vi } from "vitest";

const executeCompanyMcpXeroRead = vi.fn();
const getValidXeroAccessToken = vi.fn();
const prepareXeroMcpExecution = vi.fn();
const getConnectorInstance = vi.fn();

vi.mock("./xero-company-mcp", () => ({
  executeCompanyMcpXeroRead: (...args: unknown[]) => executeCompanyMcpXeroRead(...args),
}));

vi.mock("./xero", () => ({
  getValidXeroAccessToken: (...args: unknown[]) => getValidXeroAccessToken(...args),
}));

vi.mock("./xero-tools", async () => {
  const actual = await vi.importActual<typeof import("./xero-tools")>("./xero-tools");
  return {
    ...actual,
    prepareXeroMcpExecution: (...args: unknown[]) => prepareXeroMcpExecution(...args),
  };
});

vi.mock("./control-plane", async () => {
  const actual = await vi.importActual<typeof import("./control-plane")>("./control-plane");
  return {
    ...actual,
    getConnectorInstance: (...args: unknown[]) => getConnectorInstance(...args),
  };
});

import { executeXeroReadToolOnInfra } from "./xero-read-execution";

const env = { DB: {} } as never;

describe("executeXeroReadToolOnInfra routing", () => {
  beforeEach(() => {
    executeCompanyMcpXeroRead.mockReset();
    getValidXeroAccessToken.mockReset();
    prepareXeroMcpExecution.mockReset();
    getConnectorInstance.mockReset();
  });

  it("A: Elvex connected without INFRA credential_ref uses company MCP", async () => {
    prepareXeroMcpExecution.mockResolvedValue({ ok: true, instanceId: "ci_el_xero" });
    getConnectorInstance.mockResolvedValue({ id: "ci_el_xero", credentialRefId: null });
    executeCompanyMcpXeroRead.mockResolvedValue({
      ok: true,
      result: { source: "Xero", sales_total: 10, invoice_count: 1 },
      latencyMs: 5,
      via: "company_mcp",
      companyToolName: "search_xero_invoices",
    });

    const result = await executeXeroReadToolOnInfra(env, {
      companyId: "co_el",
      toolName: "xero_sales_summary",
      arguments: { period: "this month" },
      actor: "william@elvexpropertyservices.com",
      actorUserId: "user_william",
    });

    expect(result.ok).toBe(true);
    expect(executeCompanyMcpXeroRead).toHaveBeenCalledOnce();
    expect(getValidXeroAccessToken).not.toHaveBeenCalled();
    const forwarded = executeCompanyMcpXeroRead.mock.calls[0][1] as { arguments: Record<string, unknown> };
    expect(String(forwarded.arguments.fromDate ?? "")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(String(forwarded.arguments.toDate ?? "")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("Caddington with credential_ref stays on the INFRA-native token path", async () => {
    prepareXeroMcpExecution.mockResolvedValue({ ok: true, instanceId: "ci_cad_xero" });
    getConnectorInstance.mockResolvedValue({
      id: "ci_cad_xero",
      credentialRefId: "cred_caddington_xero",
    });
    getValidXeroAccessToken.mockResolvedValue({
      ok: false,
      status: 502,
      body: { error: "token probe", code: "XERO_AUTH_EXPIRED" },
    });

    const result = await executeXeroReadToolOnInfra(env, {
      companyId: "co_caddington",
      toolName: "xero_sales_summary",
      arguments: { fromDate: "2026-08-01", toDate: "2026-08-30" },
      actor: "caddington@example.test",
    });

    expect(getValidXeroAccessToken).toHaveBeenCalledOnce();
    expect(executeCompanyMcpXeroRead).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("XERO_AUTH_EXPIRED");
  });

  it("C: disconnected Xero does not call company MCP or unwrap a token", async () => {
    prepareXeroMcpExecution.mockResolvedValue({
      ok: false,
      status: 409,
      body: { error: "Xero isn’t connected.", code: "CONNECTOR_NOT_CONNECTED" },
    });

    const result = await executeXeroReadToolOnInfra(env, {
      companyId: "co_el",
      toolName: "xero_sales_summary",
      arguments: {},
      actor: "william@elvexpropertyservices.com",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("CONNECTOR_NOT_CONNECTED");
    }
    expect(executeCompanyMcpXeroRead).not.toHaveBeenCalled();
    expect(getValidXeroAccessToken).not.toHaveBeenCalled();
  });

  it("G: CREDENTIAL_REF_FORBIDDEN falls back to company MCP", async () => {
    prepareXeroMcpExecution.mockResolvedValue({ ok: true, instanceId: "ci_el_xero" });
    getConnectorInstance.mockResolvedValue({ id: "ci_el_xero", credentialRefId: "cred_missing" });
    getValidXeroAccessToken.mockResolvedValue({
      ok: false,
      status: 403,
      body: { error: "forbidden", code: "CREDENTIAL_REF_FORBIDDEN" },
    });
    executeCompanyMcpXeroRead.mockResolvedValue({
      ok: true,
      result: { source: "Xero", sales_total: 0, invoice_count: 0 },
      latencyMs: 3,
      via: "company_mcp",
      companyToolName: "search_xero_invoices",
    });

    const result = await executeXeroReadToolOnInfra(env, {
      companyId: "co_el",
      toolName: "xero_sales_summary",
      arguments: { fromDate: "2026-09-01", toDate: "2026-09-01" },
      actor: "william@elvexpropertyservices.com",
    });

    expect(result.ok).toBe(true);
    expect(executeCompanyMcpXeroRead).toHaveBeenCalledOnce();
  });

  it("rejects write tools on the read executor", async () => {
    const result = await executeXeroReadToolOnInfra(env, {
      companyId: "co_el",
      toolName: "xero_create_draft_invoice",
      arguments: {},
      actor: "william@elvexpropertyservices.com",
    });
    expect(result.ok).toBe(false);
    expect(prepareXeroMcpExecution).not.toHaveBeenCalled();
  });
});
