import { describe, expect, it } from "vitest";
import { XERO_WRITE_MCP_TOOLS } from "@infra/shared";
import { withXeroReadTools, xeroReadToolsAllowed } from "./xero-read-tools";

const base = [
  {
    name: "search",
    description: "Search knowledge",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  },
];

describe("withXeroReadTools", () => {
  it("advertises Xero reads for human actors and not writes", () => {
    const advertised = withXeroReadTools(base);
    const names = advertised.map((tool) => tool.name);
    expect(names).toContain("xero_sales_summary");
    expect(names).toContain("xero_search_invoices");
    expect(names).toContain("xero_get_invoice");
    expect(names).toContain("xero_list_overdue_invoices");
    expect(names).toContain("xero_top_customers");
    for (const write of XERO_WRITE_MCP_TOOLS) {
      expect(names).not.toContain(write);
    }
    const sales = advertised.find((tool) => tool.name === "xero_sales_summary");
    expect(sales?.description).toMatch(/live Xero sales/i);
    expect(sales?.description).toMatch(/Do not use company knowledge/i);
    expect(sales?.inputSchema).toMatchObject({
      type: "object",
      properties: { fromDate: { type: "string" }, toDate: { type: "string" } },
    });
  });

  it("enriches empty allowlist schemas already present", () => {
    const advertised = withXeroReadTools([
      ...base,
      { name: "xero_sales_summary", description: "xero sales summary", inputSchema: { type: "object", properties: {} } },
    ]);
    const sales = advertised.filter((tool) => tool.name === "xero_sales_summary");
    expect(sales).toHaveLength(1);
    expect(Object.keys((sales[0].inputSchema.properties ?? {}) as object).length).toBeGreaterThan(0);
  });

  it("filters service identities without Xero read scopes", () => {
    expect(xeroReadToolsAllowed(["knowledge.search"])).toBe(false);
    expect(xeroReadToolsAllowed(["xero.sales.read"])).toBe(true);
    expect(xeroReadToolsAllowed(["xero.action.create"])).toBe(false);
    expect(withXeroReadTools(base, ["knowledge.search"]).map((tool) => tool.name)).toEqual(["search"]);
  });
});
