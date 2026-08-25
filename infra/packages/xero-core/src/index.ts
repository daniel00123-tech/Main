export * from "./client";
export * as xeroReadTools from "./tools/read";
export * as xeroWriteTools from "./tools/write";

/** Map MCP tool names to read handlers for Company Business MCP integration. */
export const XERO_READ_TOOL_HANDLERS = {
  xero_get_organisation: "getOrganisation",
  xero_list_contacts: "listContacts",
  xero_search_invoices: "searchInvoices",
  xero_list_overdue_invoices: "listOverdueInvoices",
  xero_list_payments: "listPayments",
  xero_list_accounts: "listAccounts",
  xero_list_bank_transactions: "listBankTransactions",
  xero_profit_and_loss: "profitAndLoss",
  xero_balance_sheet: "balanceSheet",
  xero_aged_receivables: "agedReceivables",
  xero_sales_summary: "salesSummary",
  xero_top_customers: "topCustomers",
} as const;
