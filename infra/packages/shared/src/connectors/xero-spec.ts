/**
 * Reusable Xero connector specification for the next implementation phase.
 *
 * VERIFY AGAINST CURRENT XERO API DOCUMENTATION BEFORE IMPLEMENTATION.
 * This file is a control-plane contract, not a live integration.
 */

export const XERO_AUTH = {
  type: "oauth2" as const,
  pkceRequired: true,
  authorizationUrl: "https://login.xero.com/identity/connect/authorize",
  tokenUrl: "https://identity.xero.com/connect/token",
  requiredScopes: [
    "offline_access",
    "accounting.contacts.read",
    "accounting.transactions.read",
    "accounting.settings.read",
  ],
  optionalScopes: [
    "accounting.contacts",
    "accounting.transactions",
    "accounting.settings",
  ],
  notes: [
    "VERIFY AGAINST CURRENT XERO API DOCUMENTATION BEFORE IMPLEMENTATION.",
    "Do not collect or store Xero secrets in this phase.",
    "Financial writes require INFRA permission + approval (ADR 005).",
  ],
};

export const XERO_READ_CAPABILITIES = [
  { key: "organisation", label: "Organisation", verified: false },
  { key: "contacts", label: "Contacts", verified: false },
  { key: "invoices", label: "Invoices", verified: false },
  { key: "credit_notes", label: "Credit Notes", verified: false },
  { key: "payments", label: "Payments", verified: false },
  { key: "accounts", label: "Accounts", verified: false },
  { key: "bank_transactions", label: "Bank Transactions", verified: false },
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
  implemented: false;
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
    implemented: false,
  },
  {
    name: "xero.contacts.search",
    action: "xero.contacts.search",
    riskClass: "low_risk",
    billingOperation: "xero.contacts.search",
    auditEvent: "mcp.execution_succeeded",
    input: { query: "string", limit: "number?" },
    output: { contacts: "array" },
    implemented: false,
  },
  {
    name: "xero.invoices.search",
    action: "xero.invoices.search",
    riskClass: "low_risk",
    billingOperation: "xero.invoices.search",
    auditEvent: "mcp.execution_succeeded",
    input: { query: "string", status: "string?", limit: "number?" },
    output: { invoices: "array" },
    implemented: false,
  },
  {
    name: "xero.invoices.get",
    action: "xero.invoices.get",
    riskClass: "low_risk",
    billingOperation: "xero.invoices.get",
    auditEvent: "mcp.execution_succeeded",
    input: { invoiceId: "string" },
    output: { invoice: "object" },
    implemented: false,
  },
  {
    name: "xero.accounts.list",
    action: "xero.accounts.list",
    riskClass: "low_risk",
    billingOperation: "xero.accounts.list",
    auditEvent: "mcp.execution_succeeded",
    input: {},
    output: { accounts: "array" },
    implemented: false,
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
  },
];

export const XERO_DATA_PLANE = [
  "Xero",
  "Reusable Xero Connector",
  "Company Business MCP",
  "Company structured-data layer / warehouse",
  "Business MCP tools",
  "INFRA (identity, permission, approval, meter, audit)",
  "ChatGPT / Claude / other AI clients",
] as const;
