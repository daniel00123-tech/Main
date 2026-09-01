import { describe, expect, it } from "vitest";
import { XERO_WRITE_MCP_TOOLS } from "@infra/shared";
import {
  ADVERTISED_XERO_READ_TOOLS,
  elvexRoleMaySeeXeroReadTools,
  filterElvexXeroToolsForRole,
  serviceMaySeeXeroReadTools,
  withXeroReadTools,
  xeroReadToolsAllowed,
} from "./xero-read-tools";

const base = [{ name: "system_health", description: "health", inputSchema: { type: "object" } }];
const searchBase = [
  {
    name: "search",
    description: "Search knowledge",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  },
];

describe("Xero read tool advertisement", () => {
  it("does not overlay Xero reads for service identities without Xero read scopes", () => {
    const tools = withXeroReadTools(base, {
      actorType: "service",
      scopes: ["knowledge.search", "system.health", "xero.action.plan"],
    });
    expect(tools.some((tool) => tool.name.startsWith("xero_"))).toBe(false);
  });

  it("overlays authorised Xero READ tools when the service has sales scopes", () => {
    const tools = withXeroReadTools(base, {
      actorType: "service",
      scopes: ["xero.sales.summary", "xero.invoices.search"],
    });
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([...ADVERTISED_XERO_READ_TOOLS]),
    );
    expect(tools.some((tool) => tool.name.includes("create"))).toBe(false);
  });

  it("hides Xero tools from Elvex office_staff and shows them to finance_team", () => {
    expect(elvexRoleMaySeeXeroReadTools("office_staff")).toBe(false);
    expect(elvexRoleMaySeeXeroReadTools("finance_team")).toBe(true);

    const denied = withXeroReadTools(
      [...base, { name: "analyse_xero_sales", description: "el", inputSchema: {} }],
      { actorType: "user", companyId: "co_el", userRole: "office_staff" },
    );
    expect(denied.some((tool) => tool.name.includes("xero"))).toBe(false);

    const allowed = withXeroReadTools(base, {
      actorType: "user",
      companyId: "co_el",
      userRole: "finance_team",
    });
    expect(allowed.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["xero_sales_summary", "xero_get_invoice", "xero_top_customers"]),
    );
  });

  it("filters writes and native EL Xero tools by role", () => {
    const tools = filterElvexXeroToolsForRole(
      [
        { name: "system_health" },
        { name: "xero_sales_summary" },
        { name: "create_xero_draft_invoice" },
        { name: "search_xero_invoices" },
      ],
      "office_staff",
    );
    expect(tools.map((tool) => tool.name)).toEqual(["system_health"]);
  });

  it("advertises Xero reads for human actors and not writes", () => {
    const advertised = withXeroReadTools(searchBase);
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
      ...searchBase,
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
    expect(serviceMaySeeXeroReadTools(["knowledge.search"])).toBe(false);
    expect(withXeroReadTools(searchBase, ["knowledge.search"]).map((tool) => tool.name)).toEqual(["search"]);
  });
});
