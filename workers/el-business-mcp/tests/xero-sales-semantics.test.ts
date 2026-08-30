import { describe, expect, it } from "vitest";
import { classifyXeroQuestion, recommendedXeroTool } from "../src/xero/intent";
import { managementPeriod } from "../src/xero/dates";
import { invoiceDocumentContribution, parseProfitAndLoss, salesContribution } from "../src/xero/reports";
import { salesAnswerForMetric } from "../src/xero/sales";
import { formatGbp, salesHeadline, XERO_PNL_VAT_NOTE } from "../src/xero/presentation";
import { organisationMatchesExpected } from "../src/xero/config";
import { previewDraftDocument } from "../src/xero/service";

const AUGUST_PNL = {
  Reports: [
    {
      ReportName: "Profit and Loss",
      ReportDate: "30 August 2026",
      ReportTitles: ["Profit and Loss", "Elvex Property Services Ltd", "1 August 2026 to 30 August 2026"],
      Rows: [
        { RowType: "Header", Cells: [{ Value: "" }, { Value: "30 Aug 26" }] },
        {
          RowType: "Section",
          Title: "Income",
          Rows: [
            { RowType: "Row", Cells: [{ Value: "Sales" }, { Value: "48120.50" }] },
            { RowType: "Row", Cells: [{ Value: "Other Income" }, { Value: "4018.09" }] },
            { RowType: "SummaryRow", Cells: [{ Value: "Total Income" }, { Value: "52138.59" }] },
          ],
        },
        {
          RowType: "Section",
          Title: "Less Cost of Sales",
          Rows: [{ RowType: "SummaryRow", Cells: [{ Value: "Total Cost of Sales" }, { Value: "12000.00" }] }],
        },
        {
          RowType: "Section",
          Title: "",
          Rows: [{ RowType: "SummaryRow", Cells: [{ Value: "Gross Profit" }, { Value: "40138.59" }] }],
        },
      ],
    },
  ],
};

describe("natural language sales intent", () => {
  it("routes generic sales/revenue questions to P&L revenue, not invoice activity", () => {
    const cases = [
      ["What are our sales this month?", "sales_revenue", "analyse_xero_sales"],
      ["What have we sold in August?", "sales_revenue", "analyse_xero_sales"],
      ["What's August revenue?", "sales_revenue", "analyse_xero_sales"],
      ["How much have we invoiced this month?", "invoice_activity", "analyse_xero_invoice_activity"],
      ["How many invoices have we raised this month?", "invoice_activity", "analyse_xero_invoice_activity"],
      ["How much cash have we received this month?", "cash_received", "analyse_xero_cash_received"],
      ["What is outstanding from customers?", "receivables", "search_xero_invoices"],
    ] as const;
    for (const [question, metric, tool] of cases) {
      const routed = classifyXeroQuestion(question);
      expect(routed.metric, question).toBe(metric);
      expect(recommendedXeroTool(routed.metric), question).toBe(tool);
    }
  });

  it("does not treat sales and invoicing as interchangeable metrics", () => {
    const sales = classifyXeroQuestion("How are sales looking?");
    const invoiced = classifyXeroQuestion("Net invoicing this month");
    expect(sales.metric).toBe("sales_revenue");
    expect(invoiced.metric).toBe("invoice_activity");
    expect(sales.metric).not.toBe(invoiced.metric);
  });
});

describe("P&L sales parsing and VAT", () => {
  it("uses Total Income as authoritative sales and lists contributing income accounts", () => {
    const parsed = parseProfitAndLoss(AUGUST_PNL);
    expect(parsed.vatBasis).toBe("excluding_vat");
    expect(parsed.reportTitles.join(" ")).toMatch(/1 August 2026 to 30 August 2026/);
    expect(parsed.periods[0]?.revenue).toBe(52138.59);
    expect(parsed.periods[0]?.incomeAccounts).toEqual([
      { section: "Income", label: "Sales", amount: 48120.5 },
      { section: "Income", label: "Other Income", amount: 4018.09 },
    ]);
    const accountSum = parsed.periods[0]!.incomeAccounts.reduce((sum, row) => sum + row.amount, 0);
    expect(Number(accountSum.toFixed(2))).toBe(52138.59);
    expect(parsed.vatBasisNote).toMatch(/exclusive of VAT/);
    expect(XERO_PNL_VAT_NOTE).toMatch(/Do not divide by 1\.2/);
    expect(52138.59 / 1.2).not.toBe(parsed.periods[0]?.revenue);
  });

  it("formats the management headline as excluding VAT", () => {
    expect(salesHeadline("August 2026 month-to-date", 52138.59)).toBe(
      "August 2026 month-to-date sales are £52,138.59 excluding VAT."
    );
    expect(formatGbp(52138.59)).toBe("£52,138.59");
  });

  it("keeps invoice-document movement as a separate inc/ex VAT metric", () => {
    const invoice = invoiceDocumentContribution("ACCREC", { subTotal: 100, total: 120 });
    const credit = invoiceDocumentContribution("ACCRECCREDIT", { subTotal: 50, total: 60 });
    expect(invoice.exVat).toBe(100);
    expect(invoice.incVat).toBe(120);
    expect(credit.exVat).toBe(-50);
    expect(credit.incVat).toBe(-60);
    expect(salesContribution("ACCREC", 120) + salesContribution("ACCRECCREDIT", 1876 + 120)).toBe(-1876);
  });
});

describe("period and presentation", () => {
  it("treats 1–30 August 2026 as August month-to-date", () => {
    const period = managementPeriod("2026-08-01", "2026-08-30", "2026-08-30");
    expect(period).toMatchObject({
      from: "2026-08-01",
      to: "2026-08-30",
      label: "August 2026 month-to-date",
      isMonthToDate: true,
    });
  });
});

describe("metric answers stay distinct", () => {
  it("returns P&L sales for sales questions and invoice activity for invoicing questions", () => {
    const sales = {
      headline: "August 2026 month-to-date sales are £52,138.59 excluding VAT.",
      salesExVat: 52138.59,
      period: { from: "2026-08-01", to: "2026-08-30", label: "August 2026 month-to-date", isMonthToDate: true },
      incomeAccounts: [{ section: "Income", label: "Sales", amount: 52138.59 }],
      vatBasis: "excluding_vat" as const,
      invoiceActivity: {
        headline: "August 2026 month-to-date net invoices raised are £-1,876.00 excluding VAT (£-1,876.00 including VAT).",
        netInvoicesRaisedExVat: -1876,
        netInvoicesRaisedIncVat: -1876,
      },
    };
    const salesAnswer = salesAnswerForMetric("sales_revenue", sales as never);
    const invoiceAnswer = salesAnswerForMetric("invoice_activity", sales as never);
    expect(salesAnswer.result).toMatchObject({ salesExVat: 52138.59, vatBasis: "excluding_vat" });
    expect(invoiceAnswer.result).toMatchObject({ netInvoicesRaisedIncVat: -1876 });
    expect(JSON.stringify(salesAnswer.result)).not.toContain("netInvoicesRaisedIncVat");
    expect(invoiceAnswer.warning).toMatch(/not management sales/);
  });
});

describe("analyseManagementSales prefers P&L over invoice movement", () => {
  it("answers generic sales from P&L even when invoice activity is negative", async () => {
    const { analyseManagementSales } = await import("../src/xero/sales");
    const calls: string[] = [];
    const client = {
      organisationName: "Elvex Property Services Ltd",
      tenantId: "ec69a5fb-1b91-4cb5-a7f5-704dcecc5d2d",
      async get(path: string) {
        calls.push(path);
        if (path.includes("ProfitAndLoss")) return AUGUST_PNL;
        return {};
      },
      async post() {
        throw new Error("writes are forbidden in this test");
      },
      async getAll(_path: string, collectionKey: string) {
        if (collectionKey === "Invoices") {
          return [
            { Type: "ACCREC", Status: "AUTHORISED", Date: "2026-08-10", Total: 120, SubTotal: 100, InvoiceNumber: "INV-1" },
          ];
        }
        return [
          { Type: "ACCRECCREDIT", Status: "AUTHORISED", Date: "2026-08-12", Total: 1996, SubTotal: 1663.33, CreditNoteNumber: "CN-1" },
        ];
      },
    };
    const result = await analyseManagementSales(client as never, {
      from: "2026-08-01",
      to: "2026-08-30",
      question: "What are our sales this month?",
    });
    expect(calls.some((path) => path.includes("ProfitAndLoss"))).toBe(true);
    expect(result.salesExVat).toBe(52138.59);
    expect(result.vatBasis).toBe("excluding_vat");
    expect(result.headline).toContain("£52,138.59 excluding VAT");
    expect(result.invoiceActivity.netInvoicesRaisedIncVat).toBe(-1876);
    expect(result.reconciliation.neverDivideBy1_2).toBe(true);
    expect(result.period).toMatchObject({ from: "2026-08-01", to: "2026-08-30" });
  });
});

describe("regressions", () => {
  it("still binds only Elvex Property Services Ltd", () => {
    expect(organisationMatchesExpected("Elvex Property Services Ltd", "Elvex Property Services Ltd")).toBe(true);
    expect(organisationMatchesExpected("Caddington Holdings Ltd", "Elvex Property Services Ltd")).toBe(false);
  });

  it("draft writes remain dry-run previews", () => {
    const preview = previewDraftDocument({
      type: "ACCREC",
      kind: "invoice",
      contact: "Test Customer",
      lineItems: [{ description: "Callout", quantity: 1, unitAmount: 120 }],
    });
    expect(preview.status).toBe("DRAFT");
    expect(preview.note).toMatch(/DRAFT only/);
  });
});
