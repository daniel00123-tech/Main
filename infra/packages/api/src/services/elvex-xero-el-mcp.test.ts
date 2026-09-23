import { describe, expect, it } from "vitest";
import {
  filterInvoicesToRequestedRange,
  mapArgumentsForElMcpTool,
  resolveElMcpXeroToolName,
  resolveXeroReadArguments,
  shapeElvexXeroReadResult,
  shouldExecuteElvexXeroViaElMcp,
} from "./elvex-xero-el-mcp";

describe("Elvex Xero via EL MCP", () => {
  it("routes only Elvex Xero reads through EL MCP", () => {
    expect(shouldExecuteElvexXeroViaElMcp("co_el", "xero_sales_summary")).toBe(true);
    expect(shouldExecuteElvexXeroViaElMcp("co_el", "xero_create_draft_invoice")).toBe(false);
    expect(shouldExecuteElvexXeroViaElMcp("co_caddington", "xero_sales_summary")).toBe(false);
  });

  it("prefers INFRA tool names when EL MCP already advertises them", () => {
    expect(
      resolveElMcpXeroToolName("xero_sales_summary", ["xero_sales_summary", "analyse_xero_sales"]),
    ).toBe("xero_sales_summary");
    expect(resolveElMcpXeroToolName("xero_sales_summary", ["analyse_xero_sales"])).toBe(
      "analyse_xero_sales",
    );
    expect(resolveElMcpXeroToolName("xero_get_invoice", ["search_xero_invoices"])).toBe(
      "search_xero_invoices",
    );
  });

  it("maps invoice lookup and overdue flags onto EL search args", () => {
    const lookup = mapArgumentsForElMcpTool(
      "xero_get_invoice",
      "search_xero_invoices",
      { invoiceNumber: "INV-1001" },
    );
    expect(lookup.invoice_number).toBe("INV-1001");
    expect(lookup.query).toBe("INV-1001");

    const overdue = mapArgumentsForElMcpTool(
      "xero_list_overdue_invoices",
      "search_xero_invoices",
      {},
    );
    expect(overdue.overdue).toBe(true);
  });

  it("resolves natural periods onto fromDate/toDate in Europe/London", () => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    const today = resolveXeroReadArguments("xero_sales_summary", { period: "today" }, now);
    expect(today.fromDate).toBe("2026-09-01");
    expect(today.toDate).toBe("2026-09-01");

    const lastMonth = resolveXeroReadArguments(
      "xero_sales_summary",
      { query: "sales last month" },
      now,
    );
    expect(lastMonth.fromDate).toBe("2026-08-01");
    expect(lastMonth.toDate).toBe("2026-08-31");

    const specific = resolveXeroReadArguments(
      "xero_search_invoices",
      { period: "15 August 2026" },
      now,
    );
    expect(specific.fromDate).toBe("2026-08-15");
    expect(specific.toDate).toBe("2026-08-15");
  });

  it("filters invoice lists to the requested civil dates without inventing rows", () => {
    const filtered = filterInvoicesToRequestedRange(
      [
        { invoiceNumber: "INV-1", date: "2026-09-01", total: 498 },
        { invoiceNumber: "INV-2", date: "2026-08-31", total: 114 },
      ],
      "2026-09-01",
      "2026-09-01",
    );
    expect(filtered.invoices).toEqual([{ invoiceNumber: "INV-1", date: "2026-09-01", total: 498 }]);
    expect(filtered.unfilteredCount).toBe(2);

    const sales = shapeElvexXeroReadResult(
      "xero_sales_summary",
      { fromDate: "2026-09-01", toDate: "2026-09-01" },
      { monthToDate: { from: "2026-09-01", to: "2026-09-01", invoicedSales: -114, documentCount: 1 } },
    );
    expect(sales.summary).toEqual({
      totalSales: -114,
      transactionCount: 1,
      fromDate: "2026-09-01",
      toDate: "2026-09-01",
      currencyCode: "GBP",
    });
  });
});
