/**
 * Standardised Xero action identifiers for INFRA permission enforcement.
 * ChatGPT may request any tool; INFRA maps tool → action → permission at execution time.
 */

export type XeroActionRiskClass =
  | "low_risk"
  | "write"
  | "financial_action"
  | "external_send"
  | "delete";

export type XeroActionDefinition = {
  action: string;
  riskClass: XeroActionRiskClass;
  billingOperation: string;
  auditEvent: string;
  /** Architecture supports this action when OAuth scopes permit. */
  writesSupported: boolean;
  /** Production may execute (separate global gate). */
  productionExecutable: boolean;
};

export const XERO_WRITE_ACTIVATION = {
  writesSupported: true,
  writesEnabled: false,
} as const;

export const XERO_ACTIONS: XeroActionDefinition[] = [
  { action: "xero.organisation.read", riskClass: "low_risk", billingOperation: "xero.organisation.read", auditEvent: "mcp.execution_succeeded", writesSupported: false, productionExecutable: true },
  { action: "xero.contacts.read", riskClass: "low_risk", billingOperation: "xero.contacts.read", auditEvent: "mcp.execution_succeeded", writesSupported: false, productionExecutable: true },
  { action: "xero.contacts.search", riskClass: "low_risk", billingOperation: "xero.contacts.search", auditEvent: "mcp.execution_succeeded", writesSupported: false, productionExecutable: true },
  { action: "xero.invoices.read", riskClass: "low_risk", billingOperation: "xero.invoices.read", auditEvent: "mcp.execution_succeeded", writesSupported: false, productionExecutable: true },
  { action: "xero.invoices.search", riskClass: "low_risk", billingOperation: "xero.invoices.search", auditEvent: "mcp.execution_succeeded", writesSupported: false, productionExecutable: true },
  { action: "xero.invoices.get", riskClass: "low_risk", billingOperation: "xero.invoices.get", auditEvent: "mcp.execution_succeeded", writesSupported: false, productionExecutable: true },
  { action: "xero.payments.read", riskClass: "low_risk", billingOperation: "xero.payments.read", auditEvent: "mcp.execution_succeeded", writesSupported: false, productionExecutable: true },
  { action: "xero.accounts.read", riskClass: "low_risk", billingOperation: "xero.accounts.read", auditEvent: "mcp.execution_succeeded", writesSupported: false, productionExecutable: true },
  { action: "xero.bank_transactions.read", riskClass: "low_risk", billingOperation: "xero.bank_transactions.read", auditEvent: "mcp.execution_succeeded", writesSupported: false, productionExecutable: true },
  { action: "xero.reports.pnl.read", riskClass: "low_risk", billingOperation: "xero.reports.pnl.read", auditEvent: "mcp.execution_succeeded", writesSupported: false, productionExecutable: true },
  { action: "xero.reports.balance_sheet.read", riskClass: "low_risk", billingOperation: "xero.reports.balance_sheet.read", auditEvent: "mcp.execution_succeeded", writesSupported: false, productionExecutable: true },
  { action: "xero.reports.aged.read", riskClass: "low_risk", billingOperation: "xero.reports.aged.read", auditEvent: "mcp.execution_succeeded", writesSupported: false, productionExecutable: true },
  { action: "xero.sales.summary", riskClass: "low_risk", billingOperation: "xero.sales.summary", auditEvent: "mcp.execution_succeeded", writesSupported: false, productionExecutable: true },
  { action: "xero.top_customers", riskClass: "low_risk", billingOperation: "xero.top_customers", auditEvent: "mcp.execution_succeeded", writesSupported: false, productionExecutable: true },
  { action: "xero.health", riskClass: "low_risk", billingOperation: "xero.health", auditEvent: "connector.health_checked", writesSupported: false, productionExecutable: true },
  { action: "xero.token_refresh", riskClass: "low_risk", billingOperation: "xero.token_refresh", auditEvent: "credential.rotated", writesSupported: false, productionExecutable: true },
  { action: "xero.invoices.create", riskClass: "financial_action", billingOperation: "xero.invoices.create", auditEvent: "xero.financial_action_executed", writesSupported: true, productionExecutable: false },
  { action: "xero.invoices.update", riskClass: "financial_action", billingOperation: "xero.invoices.update", auditEvent: "xero.financial_action_executed", writesSupported: true, productionExecutable: false },
  { action: "xero.invoices.approve", riskClass: "financial_action", billingOperation: "xero.invoices.approve", auditEvent: "xero.financial_action_executed", writesSupported: true, productionExecutable: false },
  { action: "xero.invoices.send", riskClass: "external_send", billingOperation: "xero.invoices.send", auditEvent: "xero.external_send_executed", writesSupported: true, productionExecutable: false },
  { action: "xero.invoices.create_approve_send", riskClass: "external_send", billingOperation: "xero.invoices.create_approve_send", auditEvent: "xero.external_send_executed", writesSupported: true, productionExecutable: false },
  { action: "xero.bills.create", riskClass: "financial_action", billingOperation: "xero.bills.create", auditEvent: "xero.financial_action_executed", writesSupported: true, productionExecutable: false },
  { action: "xero.bills.approve", riskClass: "financial_action", billingOperation: "xero.bills.approve", auditEvent: "xero.financial_action_executed", writesSupported: true, productionExecutable: false },
  { action: "xero.bills.update", riskClass: "financial_action", billingOperation: "xero.bills.update", auditEvent: "xero.financial_action_executed", writesSupported: true, productionExecutable: false },
  { action: "xero.credit_notes.create_draft", riskClass: "financial_action", billingOperation: "xero.credit_notes.create_draft", auditEvent: "xero.financial_action_executed", writesSupported: true, productionExecutable: false },
  { action: "xero.contacts.create", riskClass: "write", billingOperation: "xero.contacts.create", auditEvent: "xero.write_executed", writesSupported: true, productionExecutable: false },
  { action: "xero.contacts.update", riskClass: "write", billingOperation: "xero.contacts.update", auditEvent: "xero.write_executed", writesSupported: true, productionExecutable: false },
  { action: "xero.credit_notes.create", riskClass: "financial_action", billingOperation: "xero.credit_notes.create", auditEvent: "xero.financial_action_executed", writesSupported: true, productionExecutable: false },
  { action: "xero.credit_notes.approve", riskClass: "financial_action", billingOperation: "xero.credit_notes.approve", auditEvent: "xero.financial_action_executed", writesSupported: true, productionExecutable: false },
  { action: "xero.credit_notes.allocate", riskClass: "financial_action", billingOperation: "xero.credit_notes.allocate", auditEvent: "xero.financial_action_executed", writesSupported: true, productionExecutable: false },
  { action: "xero.payments.create", riskClass: "financial_action", billingOperation: "xero.payments.create", auditEvent: "xero.financial_action_executed", writesSupported: true, productionExecutable: false },
  { action: "xero.payments.allocate", riskClass: "financial_action", billingOperation: "xero.payments.allocate", auditEvent: "xero.financial_action_executed", writesSupported: true, productionExecutable: false },
  { action: "xero.invoice.void", riskClass: "delete", billingOperation: "xero.invoice.void", auditEvent: "xero.destructive_action", writesSupported: true, productionExecutable: false },
  { action: "xero.bill.void", riskClass: "delete", billingOperation: "xero.bill.void", auditEvent: "xero.destructive_action", writesSupported: true, productionExecutable: false },
  { action: "xero.credit_note.void", riskClass: "delete", billingOperation: "xero.credit_note.void", auditEvent: "xero.destructive_blocked", writesSupported: true, productionExecutable: false },
];

export function xeroActionDefinition(action: string): XeroActionDefinition | undefined {
  return XERO_ACTIONS.find((row) => row.action === action);
}

export function isXeroFinancialAction(action: string): boolean {
  const def = xeroActionDefinition(action);
  return def?.riskClass === "financial_action" || def?.riskClass === "delete";
}
