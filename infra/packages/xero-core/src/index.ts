export * from "./client";
export * from "./errors";
export * from "./fetch-json";
export * from "./tax-rates";
export * from "./sales-aggregation";
export * from "./reports/profit-and-loss";
export * from "./dates";
export * from "./invoices";
export * from "./payments";
export * from "./ageing";
export * from "./pagination";
export * from "./purchase-aggregation";
export * from "./tax-info";
export {
  profitAndLossWithFetch,
  listContactsWithFetch,
  getContactWithFetch,
  listAccountsWithFetch,
  searchInvoicesWithFetch,
  getInvoiceWithFetch,
  listOverdueInvoicesWithFetch,
  listPaymentsWithFetch,
  listBankTransactionsWithFetch,
  balanceSheetWithFetch,
  agedReceivablesWithFetch,
  topSuppliersWithFetch,
  listTaxRatesWithFetch,
  vatCapabilityWithFetch,
} from "./tools/read";
export { createDraftInvoiceWithFetch } from "./tools/write";
export {
  approveInvoiceWithFetch,
  sendInvoiceWithFetch,
  updateDraftInvoiceWithFetch,
  createDraftBillWithFetch,
  approveBillWithFetch,
  createDraftCreditNoteWithFetch,
  approveCreditNoteWithFetch,
  allocateCreditNoteWithFetch,
  allocatePaymentWithFetch,
  createContactWithFetch,
  voidInvoiceWithFetch,
  voidCreditNoteWithFetch,
  deleteDraftInvoiceWithFetch,
  deleteDraftCreditNoteWithFetch,
} from "./tools/write";
export { withXeroRetry } from "./retry";
export { resolveSalesAccountCodeWithFetch, resolveExpenseAccountCodeWithFetch } from "./accounts-resolve";
export * as xeroReadTools from "./tools/read";
export * as xeroWriteTools from "./tools/write";

/** Map MCP tool names to read handlers for Company Business MCP integration. */
export const XERO_READ_TOOL_HANDLERS = {
  xero_get_organisation: "getOrganisation",
  xero_list_contacts: "listContacts",
  xero_get_contact: "getContact",
  xero_search_invoices: "searchInvoices",
  xero_get_invoice: "getInvoice",
  xero_list_overdue_invoices: "listOverdueInvoices",
  xero_list_payments: "listPayments",
  xero_list_accounts: "listAccounts",
  xero_list_bank_transactions: "listBankTransactions",
  xero_profit_and_loss: "profitAndLoss",
  xero_balance_sheet: "balanceSheet",
  xero_aged_receivables: "agedReceivables",
  xero_sales_summary: "salesSummary",
  xero_top_customers: "topCustomers",
  xero_top_suppliers: "topSuppliers",
  xero_list_tax_rates: "listTaxRates",
  xero_vat_capability: "vatCapability",
} as const;
