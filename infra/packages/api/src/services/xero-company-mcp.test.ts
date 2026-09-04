import { describe, expect, it } from "vitest";
import {
  composeInfraXeroReadResult,
  companyXeroPayloadLooksFailed,
  extractRawSalesDocuments,
  isRetryableCompanyXeroUpstream,
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
      limit: 50,
      top: 50,
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

  it("returns an honest no-result when the requested invoice number is not in the search payload", () => {
    const missed = composeInfraXeroReadResult(
      "xero_get_invoice",
      { invoiceNumber: "INV-02268" },
      {
        invoices: [
          { InvoiceNumber: "INV-02276", Type: "ACCREC", Status: "AUTHORISED", Total: 36 },
        ],
      },
      "search_xero_invoices",
    );
    expect(missed.found).toBe(false);
    expect(missed.no_results).toBe(true);
    expect(missed.invoice).toBeNull();
    expect(missed.invoiceNumber).toBe("INV-02268");
  });

  it("selects the matching invoice number from a search payload", () => {
    const hit = composeInfraXeroReadResult(
      "xero_get_invoice",
      { invoiceNumber: "INV-02268" },
      {
        invoices: [
          { InvoiceNumber: "INV-02276", Type: "ACCREC", Status: "AUTHORISED", Total: 36 },
          { InvoiceNumber: "INV-02268", Type: "ACCREC", Status: "AUTHORISED", Total: 120, Contact: { Name: "Acme" } },
        ],
      },
      "search_xero_invoices",
    );
    expect(hit.found).toBe(true);
    expect(hit.invoiceNumber).toBe("INV-02268");
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

  it("retries only transient company-MCP timeouts, never writes", () => {
    expect(isRetryableCompanyXeroUpstream(502, "MCP HTTP timeout")).toBe(true);
    expect(isRetryableCompanyXeroUpstream(503, "unavailable")).toBe(true);
    expect(isRetryableCompanyXeroUpstream(401, "unauthorized")).toBe(false);
    expect(isRetryableCompanyXeroUpstream(403, "permission denied")).toBe(false);
    expect(pickCompanyXeroTool(["create_xero_draft_invoice"], "xero_sales_summary")).toBeNull();
  });

  it("never treats INFRA facade names as live company tools unless they are actually listed", () => {
    const elvexLive = ["search_xero_invoices", "get_xero_invoice", "analyse_xero_sales", "get_xero_financial_summary"];
    expect(pickCompanyXeroTool(elvexLive, "xero_sales_summary")).toBe("search_xero_invoices");
    expect(pickCompanyXeroTool(elvexLive, "xero_search_invoices")).toBe("search_xero_invoices");
    expect(pickCompanyXeroTool(elvexLive, "xero_top_customers")).toBe("search_xero_invoices");
    expect(pickCompanyXeroTool(elvexLive, "xero_get_invoice", { invoiceNumber: "INV-0001" })).toBe(
      "search_xero_invoices",
    );
    expect(
      pickCompanyXeroTool(elvexLive, "xero_get_invoice", { invoiceId: "11111111-2222-4333-a444-555555555555" }),
    ).toBe("get_xero_invoice");
    expect(pickCompanyXeroTool(["xero_sales_summary"], "xero_sales_summary")).toBe("xero_sales_summary");
  });

  it("maps Elvex-native invoice search args (top/overdue/outstanding) without sending writes", () => {
    expect(
      mapArgsForCompanyXeroTool("xero_sales_summary", "search_xero_invoices", {
        fromDate: "2026-09-01",
        toDate: "2026-09-01",
        limit: 100,
      }),
    ).toMatchObject({
      from: "2026-09-01",
      to: "2026-09-01",
      top: 50,
    });
    expect(
      mapArgsForCompanyXeroTool("xero_list_overdue_invoices", "search_xero_invoices", {}),
    ).toMatchObject({ overdue: true, outstanding: true, overdueOnly: true, unpaidOnly: true });
    expect(
      mapArgsForCompanyXeroTool("xero_get_invoice", "get_xero_invoice", {
        invoiceId: "11111111-2222-4333-a444-555555555555",
      }),
    ).toMatchObject({ invoice_id: "11111111-2222-4333-a444-555555555555" });
    expect(mapArgsForCompanyXeroTool("xero_sales_summary", "analyse_xero_sales", { fromDate: "2026-09-01" })).toEqual({
      months: 6,
    });
  });

  it("treats EL Xero tool-error payloads as upstream failure, not empty sales", () => {
    expect(companyXeroPayloadLooksFailed({ error: "token denied", code: "EL_XERO_TOKEN_DENIED" })).toBe(true);
    expect(companyXeroPayloadLooksFailed({ invoices: [], organisation: "Elvex" })).toBe(false);
    expect(companyXeroPayloadLooksFailed({ sales_total: 0, invoice_count: 0 })).toBe(false);
  });
});
