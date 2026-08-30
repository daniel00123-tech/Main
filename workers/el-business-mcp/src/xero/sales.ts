import type { XeroClient } from "./client";
import {
  managementPeriod,
  normalizeXeroDate,
  previousMonthRange,
  rollingRange,
  toXeroDateTimeClause,
  todayIso,
} from "./dates";
import { classifyXeroQuestion, recommendedXeroTool, type XeroMetric } from "./intent";
import {
  cashHeadline,
  formatGbp,
  GBP,
  invoiceActivityHeadline,
  outstandingHeadline,
  roundMoney,
  salesHeadline,
  XERO_PNL_VAT_NOTE,
} from "./presentation";
import {
  formatInvoice,
  invoiceDocumentContribution,
  parseProfitAndLoss,
  qualifiesAsPostedSales,
} from "./reports";

async function fetchPnl(client: XeroClient, from: string, to: string) {
  const body = await client.get<{ Reports?: never[] }>("/Reports/ProfitAndLoss", {
    fromDate: from,
    toDate: to,
    standardLayout: true,
    paymentsOnly: false,
  });
  return parseProfitAndLoss(body);
}

export type InvoiceActivitySummary = {
  metric: "net_invoice_activity";
  vatBasis: "stated_separately";
  currency: "GBP";
  headline: string;
  period: { from: string; to: string; label: string; isMonthToDate: boolean };
  netInvoicesRaisedExVat: number;
  netInvoicesRaisedIncVat: number;
  invoiceCount: number;
  creditNoteCount: number;
  documentCount: number;
  note: string;
};

function sumInvoiceActivity(
  docs: Array<Record<string, unknown>>,
  from: string,
  to: string
): InvoiceActivitySummary {
  let exVat = 0;
  let incVat = 0;
  let invoiceCount = 0;
  let creditNoteCount = 0;
  for (const row of docs) {
    const type = String(row.Type ?? "");
    const date = normalizeXeroDate(row.Date);
    if (!date || date < from || date > to) continue;
    if (!qualifiesAsPostedSales(type, String(row.Status ?? ""))) continue;
    const contrib = invoiceDocumentContribution(type, {
      subTotal: row.SubTotal != null ? Number(row.SubTotal) : null,
      total: row.Total != null ? Number(row.Total) : null,
    });
    exVat += contrib.exVat;
    incVat += contrib.incVat;
    if (type === "ACCREC") invoiceCount += 1;
    if (type === "ACCRECCREDIT") creditNoteCount += 1;
  }
  const period = managementPeriod(from, to, to);
  return {
    metric: "net_invoice_activity",
    vatBasis: "stated_separately",
    currency: GBP,
    headline: invoiceActivityHeadline(period.label, roundMoney(exVat), roundMoney(incVat)),
    period,
    netInvoicesRaisedExVat: roundMoney(exVat),
    netInvoicesRaisedIncVat: roundMoney(incVat),
    invoiceCount,
    creditNoteCount,
    documentCount: invoiceCount + creditNoteCount,
    note:
      "Net invoice activity is posted sales invoices minus sales credit notes by document date. It is not management sales/revenue. Draft, void and deleted documents are excluded.",
  };
}

async function loadSalesDocuments(client: XeroClient, from: string) {
  const [invoices, credits] = await Promise.all([
    client.getAll<Record<string, unknown>>(
      "/Invoices",
      "Invoices",
      { where: `Type=="ACCREC" AND Date>=${toXeroDateTimeClause(from)}` },
      400
    ),
    client
      .getAll<Record<string, unknown>>(
        "/CreditNotes",
        "CreditNotes",
        { where: `Type=="ACCRECCREDIT" AND Date>=${toXeroDateTimeClause(from)}` },
        200
      )
      .catch(() => [] as Record<string, unknown>[]),
  ]);
  const docs: Array<Record<string, unknown>> = [
    ...invoices.map((row) => ({ ...row, Type: row.Type ?? "ACCREC" })),
    ...credits.map((row) => ({ ...row, Type: row.Type ?? "ACCRECCREDIT" })),
  ];
  return docs;
}

export async function analyseInvoiceActivity(
  client: XeroClient,
  input: { from?: string; to?: string; months?: number } = {}
) {
  const period = managementPeriod(input.from, input.to);
  const lookback = rollingRange(input.months ?? 6, period.to);
  const docs = await loadSalesDocuments(client, lookback.from);
  const current = sumInvoiceActivity(docs, period.from, period.to);
  const previous = sumInvoiceActivity(docs, previousMonthRange(period.to).from, previousMonthRange(period.to).to);
  return {
    ...current,
    previousPeriod: previous,
    rolling: sumInvoiceActivity(docs, lookback.from, lookback.to),
    largestInvoices: docs
      .filter((row) => qualifiesAsPostedSales(String(row.Type ?? ""), String(row.Status ?? "")))
      .sort((a, b) => Number(b.Total ?? 0) - Number(a.Total ?? 0))
      .slice(0, 8)
      .map((row) => formatInvoice(row)),
  };
}

export async function analyseCashReceived(
  client: XeroClient,
  input: { from?: string; to?: string } = {}
) {
  const period = managementPeriod(input.from, input.to);
  const payments = await client
    .getAll<Record<string, unknown>>(
      "/Payments",
      "Payments",
      {
        where: `PaymentType=="ACCRECPAYMENT" AND Date>=${toXeroDateTimeClause(period.from)} AND Date<=${toXeroDateTimeClause(period.to)}`,
      },
      400
    )
    .catch(() => [] as Record<string, unknown>[]);
  const amount = roundMoney(payments.reduce((sum, row) => sum + Number(row.Amount ?? 0), 0));
  return {
    metric: "cash_received" as const,
    vatBasis: "includes_vat" as const,
    currency: GBP,
    headline: cashHeadline(period.label, amount),
    period,
    cashReceived: amount,
    paymentCount: payments.length,
    vatNote:
      "Customer receipts are cash amounts. Where the underlying invoice was standard-rated, the cash includes VAT. This is not sales and not invoices raised.",
    payments: payments.slice(0, 12).map((row) => ({
      paymentId: row.PaymentID ?? null,
      date: normalizeXeroDate(row.Date),
      amount: row.Amount != null ? Number(row.Amount) : null,
      invoiceId: (row.Invoice as { InvoiceID?: string } | undefined)?.InvoiceID ?? null,
      invoiceNumber: (row.Invoice as { InvoiceNumber?: string } | undefined)?.InvoiceNumber ?? null,
    })),
  };
}

export async function analyseManagementSales(
  client: XeroClient,
  input: { from?: string; to?: string; months?: number; question?: string } = {}
) {
  const routing = classifyXeroQuestion(input.question);
  const period = managementPeriod(input.from, input.to);
  const previous = previousMonthRange(period.to);
  const lookback = rollingRange(input.months ?? 6, period.to);

  const [parsed, previousParsed, docs] = await Promise.all([
    fetchPnl(client, period.from, period.to).catch(() => null),
    fetchPnl(client, previous.from, previous.to).catch(() => null),
    loadSalesDocuments(client, lookback.from),
  ]);

  const currentPeriod = parsed?.periods[0] ?? null;
  const salesExVat = currentPeriod?.revenue ?? null;
  const previousSales = previousParsed?.periods[0]?.revenue ?? null;
  const monthOnMonthPercent =
    previousSales && previousSales !== 0 && salesExVat != null
      ? roundMoney(((salesExVat - previousSales) / previousSales) * 100)
      : null;

  const invoiceActivity = sumInvoiceActivity(docs, period.from, period.to);
  const previousInvoiceActivity = sumInvoiceActivity(docs, previous.from, previous.to);

  const differenceVsInvoiceNet =
    salesExVat == null ? null : roundMoney(salesExVat - invoiceActivity.netInvoicesRaisedExVat);

  const headline =
    salesExVat == null
      ? `${period.label} management sales are unavailable because the Xero P&L could not be read. Invoice-document movement must not be used as a substitute.`
      : salesHeadline(period.label, salesExVat);

  return {
    metric: "management_sales_revenue" as const,
    intendedFor: ["What are our sales?", "How much have we sold?", "What was revenue?", "How are sales looking?"],
    notFor: ["How much have we invoiced?", "How much cash have we received?", "What is outstanding?"],
    vatBasis: "excluding_vat" as const,
    currency: GBP,
    headline,
    period,
    salesExVat,
    previousPeriod: {
      from: previous.from,
      to: previous.to,
      label: managementPeriod(previous.from, previous.to, previous.to).label,
      salesExVat: previousSales,
    },
    monthOnMonthPercent,
    source: {
      kind: "xero_profit_and_loss",
      reportName: parsed?.reportName ?? null,
      reportTitles: parsed?.reportTitles ?? [],
      vatBasisNote: parsed?.vatBasisNote ?? XERO_PNL_VAT_NOTE,
    },
    incomeAccounts: currentPeriod?.incomeAccounts ?? [],
    profit: {
      costOfSalesExVat: currentPeriod?.costOfSales ?? null,
      grossProfit: currentPeriod?.grossProfit ?? null,
      operatingExpensesExVat: currentPeriod?.operatingExpenses ?? null,
      netProfit: currentPeriod?.netProfit ?? null,
      vatNote: "Costs and profit from the P&L are also exclusive of recoverable VAT.",
    },
    reconciliation: {
      pnlRevenueExVat: salesExVat,
      netInvoiceActivityExVat: invoiceActivity.netInvoicesRaisedExVat,
      netInvoiceActivityIncVat: invoiceActivity.netInvoicesRaisedIncVat,
      invoiceCount: invoiceActivity.invoiceCount,
      creditNoteCount: invoiceActivity.creditNoteCount,
      differenceVsInvoiceNetExVat: differenceVsInvoiceNet,
      neverDivideBy1_2: true,
      explanation:
        "Authoritative sales are P&L Total Income (or Total Revenue) for the exact period, already net of VAT. Net invoice activity uses invoice/credit-note document dates and can differ because of journals, other income accounts, lines posted away from income, or invoices dated outside this window. The VAT-inclusive invoice Total must not be mixed with P&L revenue.",
    },
    invoiceActivity: {
      ...invoiceActivity,
      previousPeriod: previousInvoiceActivity,
      useWhen: "How much did we invoice / invoices raised / net invoicing — not generic sales.",
    },
    routing: {
      ...routing,
      recommendedTool: recommendedXeroTool(routing.metric),
    },
    presentation: {
      currency: GBP,
      sales: salesExVat == null ? null : `${formatGbp(salesExVat)} excluding VAT`,
    },
  };
}

export function salesAnswerForMetric(
  metric: XeroMetric,
  sales: Awaited<ReturnType<typeof analyseManagementSales>>,
  extras?: {
    cash?: Awaited<ReturnType<typeof analyseCashReceived>>;
    outstanding?: number | null;
  }
) {
  if (metric === "invoice_activity") {
    return {
      metric,
      headline: sales.invoiceActivity.headline,
      result: sales.invoiceActivity,
      warning: "This is net invoice activity, not management sales/revenue.",
    };
  }
  if (metric === "cash_received") {
    return {
      metric,
      headline: extras?.cash?.headline ?? "Cash received is not sales.",
      result: extras?.cash ?? null,
      warning: "Cash received includes VAT where invoices were taxable and is not P&L revenue.",
    };
  }
  if (metric === "receivables") {
    return {
      metric,
      headline: outstandingHeadline(extras?.outstanding ?? null),
      result: { outstandingIncludingVat: extras?.outstanding ?? null },
      warning: "Outstanding customer debt is a receivables balance and includes VAT.",
    };
  }
  return {
    metric: "sales_revenue" as const,
    headline: sales.headline,
    result: {
      salesExVat: sales.salesExVat,
      period: sales.period,
      incomeAccounts: sales.incomeAccounts,
      vatBasis: sales.vatBasis,
    },
    warning: null,
  };
}

export { todayIso };
