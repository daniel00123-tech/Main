export const XERO_METRICS = [
  "sales_revenue",
  "invoice_activity",
  "cash_received",
  "receivables",
] as const;

export type XeroMetric = (typeof XERO_METRICS)[number];

const INVOICE_PHRASES = [
  /how much (have we |did we )?invoiced/,
  /invoices? (have we |we )?raised/,
  /net invoic/,
  /invoicing (this|last|in)/,
  /how many invoices/,
  /credit notes? (raised|issued)/,
];

const CASH_PHRASES = [
  /cash (have we |we )?received/,
  /money (in|received|collected)/,
  /receipts? (this|last|in)/,
  /customer payments?/,
  /paid us/,
];

const RECEIVABLE_PHRASES = [
  /outstanding (from )?(customers|debtors|invoices)/,
  /how much .*owed/,
  /debtors/,
  /aged receivables/,
  /unpaid invoices/,
  /what is outstanding/,
];

const SALES_PHRASES = [
  /sales (this|last|in|for|are|looking)/,
  /how (much|are) (have we sold|sales)/,
  /what (are|were|is|was) (our )?sales/,
  /what have we sold/,
  /revenue/,
  /how much have we sold/,
  /sold in /,
];

/**
 * Route natural-language finance questions to a single metric.
 * Generic "sales" / "sold" / "revenue" is management P&L revenue, never invoice movement.
 */
export function classifyXeroQuestion(question: string | null | undefined): {
  metric: XeroMetric;
  reason: string;
} {
  const text = (question ?? "").trim().toLowerCase();
  if (!text) {
    return { metric: "sales_revenue", reason: "Default management sales/revenue when no question is supplied." };
  }
  if (INVOICE_PHRASES.some((re) => re.test(text))) {
    return { metric: "invoice_activity", reason: "Question asks about invoices or credit notes raised, not accounting revenue." };
  }
  if (CASH_PHRASES.some((re) => re.test(text))) {
    return { metric: "cash_received", reason: "Question asks about cash/receipts, not sales or invoices raised." };
  }
  if (RECEIVABLE_PHRASES.some((re) => re.test(text))) {
    return { metric: "receivables", reason: "Question asks about outstanding customer debt." };
  }
  if (SALES_PHRASES.some((re) => re.test(text))) {
    return { metric: "sales_revenue", reason: "Generic sales/revenue maps to Xero P&L income excluding VAT." };
  }
  return { metric: "sales_revenue", reason: "Unrecognised finance wording defaults to management sales/revenue, not invoice activity." };
}

export function recommendedXeroTool(metric: XeroMetric): string {
  switch (metric) {
    case "sales_revenue":
      return "analyse_xero_sales";
    case "invoice_activity":
      return "analyse_xero_invoice_activity";
    case "cash_received":
      return "analyse_xero_cash_received";
    case "receivables":
      return "search_xero_invoices";
  }
}
