/**
 * Reusable Xero connector contract — full capability architecture.
 *
 * READ tools are production-executable via Company Business MCP + INFRA OAuth.
 * WRITE tool contracts are defined but production execution stays disabled
 * until XERO_WRITE_ACTIVATION.writesEnabled is explicitly approved.
 */

import { XERO_WRITE_ACTIVATION } from "./xero-actions";
import {
  XERO_DEFAULT_REDIRECT_URI,
  XERO_READ_SCOPES,
  XERO_SCOPE_REASONS,
  XERO_WRITE_SCOPES,
  scopesForTier,
} from "./xero-scopes";

export const XERO_CLIENT_ID_SECRET = "XERO_CLIENT_ID";
export const XERO_CLIENT_SECRET_SECRET = "XERO_CLIENT_SECRET";
export const XERO_REDIRECT_URI_SECRET = "XERO_OAUTH_REDIRECT_URI";

export { XERO_DEFAULT_REDIRECT_URI, XERO_SCOPE_REASONS, XERO_READ_SCOPES, XERO_WRITE_SCOPES };

export const XERO_AUTH = {
  type: "oauth2" as const,
  pkceRequired: true,
  authorizationUrl: "https://login.xero.com/identity/connect/authorize",
  tokenUrl: "https://identity.xero.com/connect/token",
  connectionsUrl: "https://api.xero.com/connections",
  apiBaseUrl: "https://api.xero.com/api.xro/2.0",
  callbackPath: "/api/connectors/xero/oauth/callback",
  /** Initial connect: read tier granular scopes only. */
  requiredScopes: [...XERO_READ_SCOPES],
  /** Scope upgrade adds write tier scopes via re-consent. */
  writeScopes: [...XERO_WRITE_SCOPES],
  optionalScopes: [] as string[],
  accessTokenLifetimeSeconds: 1800,
  refreshTokenRotates: true,
} as const;

export type XeroToolContract = {
  name: string;
  action: string;
  riskClass: "low_risk" | "write" | "financial_action" | "external_send" | "delete";
  billingOperation: string;
  auditEvent: string;
  input: Record<string, string>;
  output: Record<string, string>;
  /** Control-plane + MCP contract ready. */
  implemented: boolean;
  /** Company MCP must implement; INFRA never invents data. */
  mcpToolName: string;
  requiresWriteScopes?: boolean;
  usesExecutionPlan?: boolean;
};

export const XERO_TOOL_CONTRACTS: XeroToolContract[] = [
  {
    name: "xero.organisation.read",
    action: "xero.organisation.read",
    riskClass: "low_risk",
    billingOperation: "xero.organisation.read",
    auditEvent: "mcp.execution_succeeded",
    input: {},
    output: { organisation: "object" },
    implemented: true,
    mcpToolName: "xero_get_organisation",
  },
  {
    name: "xero.contacts.search",
    action: "xero.contacts.search",
    riskClass: "low_risk",
    billingOperation: "xero.contacts.search",
    auditEvent: "mcp.execution_succeeded",
    input: { query: "string?", contactType: "string?", limit: "number?" },
    output: { contacts: "array" },
    implemented: true,
    mcpToolName: "xero_list_contacts",
  },
  {
    name: "xero.contacts.get",
    action: "xero.contacts.read",
    riskClass: "low_risk",
    billingOperation: "xero.contacts.read",
    auditEvent: "mcp.execution_succeeded",
    input: { contactId: "string" },
    output: { contact: "object" },
    implemented: true,
    mcpToolName: "xero_get_contact",
  },
  {
    name: "xero.invoices.search",
    action: "xero.invoices.search",
    riskClass: "low_risk",
    billingOperation: "xero.invoices.search",
    auditEvent: "mcp.execution_succeeded",
    input: {
      query: "string?",
      status: "string?",
      contactId: "string?",
      overdueOnly: "boolean?",
      unpaidOnly: "boolean?",
      fromDate: "string?",
      toDate: "string?",
      limit: "number?",
    },
    output: { invoices: "array" },
    implemented: true,
    mcpToolName: "xero_search_invoices",
  },
  {
    name: "xero.invoices.get",
    action: "xero.invoices.get",
    riskClass: "low_risk",
    billingOperation: "xero.invoices.get",
    auditEvent: "mcp.execution_succeeded",
    input: { invoiceId: "string?", invoiceNumber: "string?" },
    output: { invoice: "object" },
    implemented: true,
    mcpToolName: "xero_get_invoice",
  },
  {
    name: "xero.invoices.overdue",
    action: "xero.invoices.read",
    riskClass: "low_risk",
    billingOperation: "xero.invoices.read",
    auditEvent: "mcp.execution_succeeded",
    input: { contactId: "string?", limit: "number?" },
    output: { invoices: "array" },
    implemented: true,
    mcpToolName: "xero_list_overdue_invoices",
  },
  {
    name: "xero.payments.read",
    action: "xero.payments.read",
    riskClass: "low_risk",
    billingOperation: "xero.payments.read",
    auditEvent: "mcp.execution_succeeded",
    input: { since: "string?", toDate: "string?", limit: "number?" },
    output: { payments: "array" },
    implemented: true,
    mcpToolName: "xero_list_payments",
  },
  {
    name: "xero.accounts.list",
    action: "xero.accounts.read",
    riskClass: "low_risk",
    billingOperation: "xero.accounts.read",
    auditEvent: "mcp.execution_succeeded",
    input: { accountType: "string?" },
    output: { accounts: "array" },
    implemented: true,
    mcpToolName: "xero_list_accounts",
  },
  {
    name: "xero.bank_transactions.read",
    action: "xero.bank_transactions.read",
    riskClass: "low_risk",
    billingOperation: "xero.bank_transactions.read",
    auditEvent: "mcp.execution_succeeded",
    input: { since: "string?", toDate: "string?", limit: "number?" },
    output: { bankTransactions: "array" },
    implemented: true,
    mcpToolName: "xero_list_bank_transactions",
  },
  {
    name: "xero.reports.profit_and_loss",
    action: "xero.reports.pnl.read",
    riskClass: "low_risk",
    billingOperation: "xero.reports.pnl.read",
    auditEvent: "mcp.execution_succeeded",
    input: { fromDate: "string?", toDate: "string?" },
    output: { report: "object" },
    implemented: true,
    mcpToolName: "xero_profit_and_loss",
  },
  {
    name: "xero.reports.balance_sheet",
    action: "xero.reports.balance_sheet.read",
    riskClass: "low_risk",
    billingOperation: "xero.reports.balance_sheet.read",
    auditEvent: "mcp.execution_succeeded",
    input: { date: "string?" },
    output: { report: "object" },
    implemented: true,
    mcpToolName: "xero_balance_sheet",
  },
  {
    name: "xero.reports.aged",
    action: "xero.reports.aged.read",
    riskClass: "low_risk",
    billingOperation: "xero.reports.aged.read",
    auditEvent: "mcp.execution_succeeded",
    input: { reportType: "string?", date: "string?" },
    output: { report: "object" },
    implemented: true,
    mcpToolName: "xero_aged_receivables",
  },
  {
    name: "xero.sales.summary",
    action: "xero.sales.summary",
    riskClass: "low_risk",
    billingOperation: "xero.sales.summary",
    auditEvent: "mcp.execution_succeeded",
    input: { fromDate: "string", toDate: "string" },
    output: { summary: "object" },
    implemented: true,
    mcpToolName: "xero_sales_summary",
  },
  {
    name: "xero.top_customers",
    action: "xero.top_customers",
    riskClass: "low_risk",
    billingOperation: "xero.top_customers",
    auditEvent: "mcp.execution_succeeded",
    input: { fromDate: "string?", toDate: "string?", limit: "number?" },
    output: { customers: "array" },
    implemented: true,
    mcpToolName: "xero_top_customers",
  },
  {
    name: "xero.invoices.create_draft",
    action: "xero.invoices.create",
    riskClass: "financial_action",
    billingOperation: "xero.invoices.create",
    auditEvent: "xero.financial_action_executed",
    input: { contactId: "string", lineItems: "array", reference: "string?", date: "string?" },
    output: { invoice: "object" },
    implemented: true,
    mcpToolName: "xero_create_draft_invoice",
    requiresWriteScopes: true,
  },
  {
    name: "xero.invoices.update_draft",
    action: "xero.invoices.update",
    riskClass: "financial_action",
    billingOperation: "xero.invoices.update",
    auditEvent: "xero.financial_action_executed",
    input: { invoiceId: "string", patch: "object" },
    output: { invoice: "object" },
    implemented: true,
    mcpToolName: "xero_update_draft_invoice",
    requiresWriteScopes: true,
  },
  {
    name: "xero.credit_notes.create",
    action: "xero.credit_notes.create",
    riskClass: "financial_action",
    billingOperation: "xero.credit_notes.create",
    auditEvent: "xero.financial_action_executed",
    input: { contactId: "string", lineItems: "array", reference: "string?" },
    output: { creditNote: "object" },
    implemented: true,
    mcpToolName: "xero_create_credit_note",
    requiresWriteScopes: true,
    usesExecutionPlan: true,
  },
  {
    name: "xero.credit_notes.allocate",
    action: "xero.credit_notes.allocate",
    riskClass: "financial_action",
    billingOperation: "xero.credit_notes.allocate",
    auditEvent: "xero.financial_action_executed",
    input: { creditNoteId: "string", allocations: "array" },
    output: { allocations: "array" },
    implemented: true,
    mcpToolName: "xero_allocate_credit_note",
    requiresWriteScopes: true,
    usesExecutionPlan: true,
  },
  {
    name: "xero.payments.allocate",
    action: "xero.payments.allocate",
    riskClass: "financial_action",
    billingOperation: "xero.payments.allocate",
    auditEvent: "xero.financial_action_executed",
    input: { paymentId: "string", allocations: "array" },
    output: { payment: "object" },
    implemented: true,
    mcpToolName: "xero_allocate_payment",
    requiresWriteScopes: true,
    usesExecutionPlan: true,
  },
  {
    name: "xero.contacts.upsert",
    action: "xero.contacts.create",
    riskClass: "write",
    billingOperation: "xero.contacts.create",
    auditEvent: "xero.write_executed",
    input: { contact: "object" },
    output: { contact: "object" },
    implemented: true,
    mcpToolName: "xero_create_or_update_contact",
    requiresWriteScopes: true,
  },
];

export const XERO_READ_MCP_TOOLS = XERO_TOOL_CONTRACTS.filter(
  (tool) => tool.riskClass === "low_risk" && tool.implemented,
).map((tool) => tool.mcpToolName);

export const XERO_WRITE_MCP_TOOLS = XERO_TOOL_CONTRACTS.filter(
  (tool) => tool.riskClass !== "low_risk" && tool.implemented,
).map((tool) => tool.mcpToolName);

export const XERO_ALL_MCP_TOOLS = XERO_TOOL_CONTRACTS.filter((t) => t.implemented).map(
  (t) => t.mcpToolName,
);

export const XERO_DATA_PLANE = [
  "Xero",
  "Reusable Xero Connector (INFRA OAuth + encrypted tokens)",
  "Company Business MCP / company data layer",
  "INFRA (identity, permission, meter, audit)",
  "ChatGPT / Claude / other AI clients",
] as const;

export function xeroScopesForConnect(tier: "read" | "write" = "read"): string[] {
  return scopesForTier(tier);
}

export function xeroWriteActivationState() {
  return { ...XERO_WRITE_ACTIVATION };
}

/** Legacy aliases for existing tests/routes. */
export const XERO_READ_CAPABILITIES = XERO_READ_MCP_TOOLS.map((name) => ({
  key: name,
  label: name,
  verified: true,
}));

export const XERO_WRITE_CAPABILITIES_FUTURE = XERO_WRITE_MCP_TOOLS.map((name) => ({
  key: name,
  label: name,
  risk: "financial_action" as const,
}));
