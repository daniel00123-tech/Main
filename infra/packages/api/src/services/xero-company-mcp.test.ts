import { describe, expect, it } from "vitest";
import {
  composeInfraXeroReadResult,
  extractRawSalesDocuments,
  mapArgsForCompanyXeroTool,
  pickCompanyXeroTool,
} from "./xero-company-mcp";

describe("company MCP Xero mapping", () => {
  it("picks Elvex-native invoice search for INFRA sales and invoice tools", () => {
    const available = ["search_xero_invoices", "analyse_xero_sales", "create_xero_draft_invoice"];
    expect(pickCompanyXeroTool(available, "xero_sales_summary")).toBe("search_xero_invoices");
    expect(pickCompanyXeroTool(available, "xero_search_invoices")).toBe("search_xero_invoices");
    expect(pickCompanyXeroTool(available, "xero_list_overdue_invoices")).toBe("search_xero_invoices");
    expect(pickCompanyXeroTool(available, "xero_create_draft_invoice")).toBeNull();
    expect(pickCompanyXeroTool(["create_xero_draft_invoice"], "xero_sales_summary")).toBeNull();
  });

  it("forwards both fromDate and from, and overdue filters", () => {
    expect(
      mapArgsForCompanyXeroTool("xero_sales_summary", "search_xero_invoices", {
        fromDate: "2026-09-01",
        toDate: "2026-09-01",
      }),
    ).toMatchObject({
      fromDate: "2026-09-01",
      toDate: "2026-09-01",
      from: "2026-09-01",
      to: "2026-09-01",
      invoiceType: "ACCREC",
      limit: 100,
    });
    expect(
      mapArgsForCompanyXeroTool("xero_list_overdue_invoices", "search_xero_invoices", {}),
    ).toMatchObject({ overdueOnly: true, unpaidOnly: true });
    expect(
      mapArgsForCompanyXeroTool("xero_search_invoices", "search_xero_invoices", {
        fromDate: "2026-09-01",
        toDate: "2026-09-01",
        query: "invoiced today 01/09/2026",
      }).query,
    ).toBeUndefined();
  });

  it("composes INFRA sales totals from Xero invoice rows and treats empty lists as zero", () => {
    const composed = composeInfraXeroReadResult(
      "xero_sales_summary",
      { fromDate: "2026-09-01", toDate: "2026-09-01", periodLabel: "today" },
      {
        invoices: [
          {
            InvoiceNumber: "INV-100",
            Type: "ACCREC",
            Status: "AUTHORISED",
            Total: 120,
            Contact: { Name: "Acme" },
          },
          {
            InvoiceNumber: "INV-101",
            Type: "ACCREC",
            Status: "VOIDED",
            Total: 50,
            Contact: { Name: "Voided Ltd" },
          },
        ],
      },
      "search_xero_invoices",
    );
    expect(composed.source).toBe("Xero");
    expect(composed.sales_total).toBe(120);
    expect(composed.invoice_count).toBe(1);
    expect(composed.summary).toMatchObject({ fromDate: "2026-09-01", toDate: "2026-09-01", totalSales: 120 });

    const empty = composeInfraXeroReadResult(
      "xero_sales_summary",
      { fromDate: "2026-09-01", toDate: "2026-09-01" },
      { invoices: [] },
      "search_xero_invoices",
    );
    expect(empty.sales_total).toBe(0);
    expect(empty.invoice_count).toBe(0);
  });

  it("lists invoice numbers for a date query", () => {
    const listed = composeInfraXeroReadResult(
      "xero_search_invoices",
      { fromDate: "2026-09-01", toDate: "2026-09-01" },
      { invoices: [{ InvoiceNumber: "INV-9", Type: "ACCREC", Status: "AUTHORISED", Total: 10 }] },
      "search_xero_invoices",
    );
    expect(listed.invoice_numbers).toEqual(["INV-9"]);
  });

  it("does not invent sales totals from a narrative-only analyse result", () => {
    const raw = extractRawSalesDocuments({ analysis: "Sales look healthy", text: "no invoices" });
    expect(raw).toEqual([]);
    const wrapped = composeInfraXeroReadResult(
      "xero_sales_summary",
      { fromDate: "2026-09-01", toDate: "2026-09-01" },
      { analysis: "Sales look healthy" },
      "analyse_xero_sales",
    );
    expect(wrapped.sales_total).toBeUndefined();
    expect(wrapped.source).toBe("Xero");
    expect(wrapped.analysis).toBe("Sales look healthy");
  });
});
