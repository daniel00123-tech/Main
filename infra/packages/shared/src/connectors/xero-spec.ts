/**
 * Reusable Xero connector contract.
 *
 * Phase one is READ ONLY. Write scopes and financial-action tools stay
 * specified but unimplemented.
 */

export const XERO_CLIENT_ID_SECRET = "XERO_CLIENT_ID";
export const XERO_CLIENT_SECRET_SECRET = "XERO_CLIENT_SECRET";
export const XERO_REDIRECT_URI_SECRET = "XERO_OAUTH_REDIRECT_URI";

export const XERO_DEFAULT_REDIRECT_URI =
  "https://infra-api.daniel-dwyer123.workers.dev/api/connectors/xero/oauth/callback";

export const XERO_AUTH = {
  type: "oauth2" as const,
  pkceRequired: true,
  authorizationUrl: "https://login.xero.com/identity/connect/authorize",
  tokenUrl: "https://identity.xero.com/connect/token",
  connectionsUrl: "https://api.xero.com/connections",
  apiBaseUrl: "https://api.xero.com/api.xro/2.0",
  callbackPath: "/api/connectors/xero/oauth/callback",
  requiredScopes: [
    "offline_access",
    "accounting.settings.read",
    "accounting.contacts.read",
    "accounting.transactions.read",
    "accounting.reports.read",
  ],
  optionalScopes: [] as string[],
  writeScopesNeverRequested: [
    "accounting.contacts",
    "accounting.transactions",
    "accounting.settings",
    "accounting.attachments",
    "payroll.employees",
    "payroll.payruns",
  ],
} as const;

export const XERO_SCOPE_REASONS: Record<string, string> = {
  offline_access:
    "Issues a refresh token so INFRA can renew access without another consent screen.",
  "accounting.settings.read":
    "Organisation profile, accounting settings, and chart of accounts.",
  "accounting.contacts.read":
    "Customers/suppliers for debtor questions and invoice counterparties.",
  "accounting.transactions.read":
    "Invoices, credit notes, payments, and bank transactions (read only).",
  "accounting.reports.read":
    "Bounded P&L and other financial reports Xero already computes.",
};

export const XERO_READ_CAPABILITIES = [
  { key: "organisation", label: "Organisation", verified: true },
  { key: "contacts", label: "Contacts", verified: true },
  { key: "invoices", label: "Invoices", verified: true },
  { key: "credit_notes", label: "Credit Notes", verified: true },
  { key: "payments", label: "Payments", verified: true },
  { key: "accounts", label: "Accounts", verified: true },
  { key: "bank_transactions", label: "Bank Transactions", verified: true },
  { key: "reports", label: "Reports", verified: true },
] as const;

export const XERO_WRITE_CAPABILITIES_FUTURE = [
  { key: "invoices.create_draft", label: "Create draft invoice", risk: "financial_action" },
  { key: "invoices.update_draft", label: "Update draft invoice", risk: "financial_action" },
  { key: "invoices.send", label: "Send invoice", risk: "external_send" },
] as const;

export type XeroToolContract = {
  name: string;
  action: string;
  riskClass: "low_risk" | "write" | "financial_action" | "external_send";
  billingOperation: string;
  auditEvent: string;
  input: Record<string, string>;
  output: Record<string, string>;
  /** Control-plane contract ready. Company MCP still owns live accounting data. */
  implemented: boolean;
  mcpToolName: string;
};

export const XERO_TOOL_CONTRACTS: XeroToolContract[] = [
  {
    name: "xero.organisation.read",
    action: "xero.organisation.read",
    riskClass: "low_risk",
    billingOperation: "xero.organisation.read",
    auditEvent: "mcp.execution_succeeded",
    input: {},
    output: { organisationName: "string", organisationId: "string" },
    implemented: true,
    mcpToolName: "xero_organisation_read",
  },
  {
    name: "xero.contacts.search",
    action: "xero.contacts.search",
    riskClass: "low_risk",
    billingOperation: "xero.contacts.search",
    auditEvent: "mcp.execution_succeeded",
    input: { query: "string", limit: "number?" },
    output: { contacts: "array" },
    implemented: true,
    mcpToolName: "xero_contacts_search",
  },
  {
    name: "xero.invoices.search",
    action: "xero.invoices.search",
    riskClass: "low_risk",
    billingOperation: "xero.invoices.search",
    auditEvent: "mcp.execution_succeeded",
    input: { query: "string", status: "string?", overdueOnly: "boolean?", limit: "number?" },
    output: { invoices: "array" },
    implemented: true,
    mcpToolName: "xero_invoices_search",
  },
  {
    name: "xero.invoices.get",
    action: "xero.invoices.get",
    riskClass: "low_risk",
    billingOperation: "xero.invoices.get",
    auditEvent: "mcp.execution_succeeded",
    input: { invoiceId: "string", invoiceNumber: "string?" },
    output: { invoice: "object" },
    implemented: true,
    mcpToolName: "xero_invoices_get",
  },
  {
    name: "xero.payments.read",
    action: "xero.payments.read",
    riskClass: "low_risk",
    billingOperation: "xero.payments.read",
    auditEvent: "mcp.execution_succeeded",
    input: { since: "string?", limit: "number?" },
    output: { payments: "array" },
    implemented: true,
    mcpToolName: "xero_payments_read",
  },
  {
    name: "xero.accounts.list",
    action: "xero.accounts.list",
    riskClass: "low_risk",
    billingOperation: "xero.accounts.list",
    auditEvent: "mcp.execution_succeeded",
    input: {},
    output: { accounts: "array" },
    implemented: true,
    mcpToolName: "xero_accounts_list",
  },
  {
    name: "xero.bank_transactions.read",
    action: "xero.bank_transactions.read",
    riskClass: "low_risk",
    billingOperation: "xero.bank_transactions.read",
    auditEvent: "mcp.execution_succeeded",
    input: { since: "string?", limit: "number?" },
    output: { bankTransactions: "array" },
    implemented: true,
    mcpToolName: "xero_bank_transactions_read",
  },
  {
    name: "xero.reports.profit_and_loss",
    action: "xero.reports.profit_and_loss",
    riskClass: "low_risk",
    billingOperation: "xero.reports.profit_and_loss",
    auditEvent: "mcp.execution_succeeded",
    input: { fromDate: "string?", toDate: "string?" },
    output: { report: "object" },
    implemented: true,
    mcpToolName: "xero_profit_and_loss",
  },
  {
    name: "xero.invoices.create_draft",
    action: "xero.invoices.create_draft",
    riskClass: "financial_action",
    billingOperation: "xero.invoices.create_draft",
    auditEvent: "mcp.execution_succeeded",
    input: { contactId: "string", lineItems: "array" },
    output: { invoice: "object" },
    implemented: false,
    mcpToolName: "xero_invoices_create_draft",
  },
];

export const XERO_READ_MCP_TOOLS = XERO_TOOL_CONTRACTS.filter(
  (tool) => tool.implemented && tool.riskClass === "low_risk",
).map((tool) => tool.mcpToolName);

export const XERO_DATA_PLANE = [
  "Xero",
  "Reusable Xero Connector (INFRA OAuth + encrypted tokens)",
  "Company Business MCP / company data layer",
  "INFRA (identity, permission, meter, audit)",
  "ChatGPT / Claude / other AI clients",
] as const;
