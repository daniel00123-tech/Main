import { describe, expect, it } from "vitest";
import {
  ADVERTISED_XERO_READ_TOOLS,
  elvexRoleMaySeeXeroReadTools,
  filterElvexXeroToolsForRole,
  serviceMaySeeXeroReadTools,
  withXeroReadTools,
} from "./xero-read-tools";

const base = [{ name: "system_health", description: "health", inputSchema: { type: "object" } }];

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
});
