/** Customer-friendly labels for technical tool/action identifiers. */
const ACTION_LABELS: Record<string, string> = {
  "knowledge.search": "Search company knowledge",
  "knowledge.read": "Read company knowledge",
  "system.health": "Check system health",
  "xero.list_contacts": "Search Xero contacts",
  "xero.get_contact": "View Xero contact",
  "xero.list_invoices": "Search Xero invoices",
  "xero.get_invoice": "View Xero invoice",
  "xero.profit_and_loss": "View profit & loss report",
  "xero.balance_sheet": "View balance sheet",
  "xero.list_accounts": "Search Xero accounts",
  "xero.list_tax_rates": "Search Xero tax rates",
  "xero.draft_invoice": "Prepare draft Xero invoice",
  "xero.create_draft_invoice": "Create draft Xero invoice",
  "plan.xero_draft_invoice": "Prepare draft Xero invoice",
  "search_company_knowledge": "Search company knowledge",
};

const TOOL_LABELS: Record<string, string> = {
  xero_list_contacts: "Search Xero contacts",
  xero_profit_and_loss: "View profit & loss report",
  xero_balance_sheet: "View balance sheet",
  xero_list_invoices: "Search Xero invoices",
  plan_xero_draft_invoice: "Prepare draft Xero invoice",
  search_company_knowledge: "Search company knowledge",
};

export function humaniseActionLabel(action: string): string {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action];
  const normalised = action.replace(/[._]/g, " ");
  return normalised.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function humaniseToolLabel(toolName: string): string {
  if (TOOL_LABELS[toolName]) return TOOL_LABELS[toolName];
  return toolName.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
