import type { ElvexCapability } from "./capabilities";

/**
 * Xero tools register against these capabilities. The connector can add
 * new tool names here without changing the authorisation engine.
 */
export const XERO_TOOL_CAPABILITIES: Record<string, ElvexCapability> = {
  search_xero_invoices: "xero.sales.read",
  analyse_xero_sales: "xero.sales.read",
  analyse_xero_invoice_activity: "xero.sales.read",
  analyse_xero_cash_received: "xero.sales.read",
  analyse_xero_customers: "xero.sales.read",
  search_xero_contacts: "xero.sales.read",
  get_xero_invoice: "xero.sales.read",
  search_xero_bills: "xero.finance.read",
  get_xero_financial_summary: "xero.finance.read",
  analyse_xero_suppliers: "xero.finance.read",
  get_xero_report: "xero.finance.read",
  create_xero_draft_invoice: "xero.draft.write",
  create_xero_quote: "xero.draft.write",
  create_xero_draft_bill: "xero.draft.write",
  create_xero_draft_credit_note: "xero.draft.write",
};

const SALES_REPORTS = new Set(["agedreceivables", "aged_receivables"]);
const SETTINGS_REPORTS = new Set(["organisation", "settings"]);
const FINANCE_REPORTS = new Set([
  "profitandloss",
  "profit_and_loss",
  "balancesheet",
  "balance_sheet",
  "trialbalance",
  "trial_balance",
  "banksummary",
  "bank_summary",
  "executivesummary",
  "executive_summary",
  "agedpayables",
  "aged_payables",
]);

export function registerXeroToolCapability(toolName: string, capability: ElvexCapability): void {
  XERO_TOOL_CAPABILITIES[toolName] = capability;
}

export function xeroCapabilityForTool(
  toolName: string,
  args: Record<string, unknown> = {}
): ElvexCapability | null {
  if (toolName === "get_xero_report") {
    const report = String(args.report ?? "").toLowerCase().replace(/[\s-]+/g, "");
    if (SALES_REPORTS.has(report) || SALES_REPORTS.has(String(args.report ?? "").toLowerCase())) {
      return "xero.sales.read";
    }
    if (SETTINGS_REPORTS.has(report) || SETTINGS_REPORTS.has(String(args.report ?? "").toLowerCase())) {
      return "xero.settings.read";
    }
    if (FINANCE_REPORTS.has(report) || !report) {
      return "xero.finance.read";
    }
    return "xero.finance.read";
  }
  if (toolName === "search_xero_contacts") {
    const role = String(args.role ?? "all").toLowerCase();
    if (role === "supplier") return "xero.finance.read";
    return "xero.sales.read";
  }
  return XERO_TOOL_CAPABILITIES[toolName] ?? null;
}

export function isXeroWriteTool(toolName: string): boolean {
  return xeroCapabilityForTool(toolName) === "xero.draft.write" ||
    xeroCapabilityForTool(toolName) === "xero.contacts.write";
}
