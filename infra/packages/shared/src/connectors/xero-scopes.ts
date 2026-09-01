/**
 * Xero OAuth scope tiers for reusable multi-tenant connectors.
 *
 * Apps created on or after 2 March 2026 must use granular scopes only.
 * Broad `accounting.transactions` / `accounting.reports.read` are rejected.
 */

import { XERO_LEGACY_REDIRECT_URI } from "../platform/urls";

/**
 * Legacy workers.dev redirect URI. New authorisations use
 * XERO_CANONICAL_REDIRECT_URI unless XERO_OAUTH_REDIRECT_URI overrides.
 */
export const XERO_DEFAULT_REDIRECT_URI = XERO_LEGACY_REDIRECT_URI;

export type XeroScopeTier = "read" | "write";

/** Initial OAuth consent — read-only granular scopes. */
export const XERO_READ_SCOPES = [
  "offline_access",
  "accounting.settings.read",
  "accounting.contacts.read",
  "accounting.invoices.read",
  "accounting.payments.read",
  "accounting.banktransactions.read",
  "accounting.reports.profitandloss.read",
  "accounting.reports.balancesheet.read",
  "accounting.reports.aged.read",
] as const;

/** Additional scopes requested only via deliberate admin scope-upgrade + re-consent. */
export const XERO_WRITE_SCOPES = [
  "accounting.invoices",
  "accounting.payments",
  "accounting.contacts",
] as const;

/** High-risk scopes reserved for explicit future activation — never requested by default. */
export const XERO_DESTRUCTIVE_SCOPES_NEVER_REQUESTED = [
  "accounting.manualjournals",
  "accounting.banktransactions",
  "accounting.attachments",
  "payroll.employees",
  "payroll.payruns",
] as const;

export const XERO_SCOPE_TIERS: Record<
  XeroScopeTier,
  { scopes: readonly string[]; label: string; description: string }
> = {
  read: {
    scopes: XERO_READ_SCOPES,
    label: "Read access",
    description:
      "Organisation, contacts, invoices, payments, bank transactions, and bounded reports.",
  },
  write: {
    scopes: XERO_WRITE_SCOPES,
    label: "Financial write capabilities",
    description:
      "Draft/update invoices, credit notes, payment allocation, and contact updates. Requires admin re-consent.",
  },
};

export const XERO_SCOPE_REASONS: Record<string, string> = {
  offline_access:
    "Issues a refresh token so INFRA can renew access without another consent screen.",
  "accounting.settings.read":
    "Organisation profile, accounting settings, chart of accounts, and tax rates.",
  "accounting.contacts.read":
    "Customers and suppliers for debtor/creditor questions and invoice counterparties.",
  "accounting.invoices.read":
    "Invoices, credit notes, quotes, purchase orders, and items (read only).",
  "accounting.payments.read":
    "Payments, batch payments, overpayments, and prepayments (read only).",
  "accounting.banktransactions.read":
    "Bank transactions and transfers for cash-position questions (read only).",
  "accounting.reports.profitandloss.read":
    "Bounded Profit & Loss reports Xero already computes.",
  "accounting.reports.balancesheet.read":
    "Balance Sheet reports for financial position questions.",
  "accounting.reports.aged.read":
    "Aged receivables/payables for debtor and creditor position.",
  "accounting.invoices":
    "Create/update invoices and credit notes (write — scope upgrade only).",
  "accounting.payments":
    "Record and allocate payments (write — scope upgrade only).",
  "accounting.contacts":
    "Create/update contacts (write — scope upgrade only).",
};

export type XeroCapabilityMatrixRow = {
  capability: string;
  scopes: string[];
  action: string;
  riskClass: "low_risk" | "write" | "financial_action" | "external_send" | "delete";
  mcpToolName?: string;
  apiEndpoints: string[];
  notes?: string;
};

/** Capability → scope → action mapping for documentation and portal display. */
export const XERO_CAPABILITY_MATRIX: XeroCapabilityMatrixRow[] = [
  {
    capability: "Organisation / settings",
    scopes: ["accounting.settings.read"],
    action: "xero.organisation.read",
    riskClass: "low_risk",
    mcpToolName: "xero_get_organisation",
    apiEndpoints: ["GET /Organisation", "GET /Accounts"],
  },
  {
    capability: "Contacts",
    scopes: ["accounting.contacts.read"],
    action: "xero.contacts.read",
    riskClass: "low_risk",
    mcpToolName: "xero_list_contacts",
    apiEndpoints: ["GET /Contacts"],
  },
  {
    capability: "Invoices / credit notes",
    scopes: ["accounting.invoices.read"],
    action: "xero.invoices.read",
    riskClass: "low_risk",
    mcpToolName: "xero_search_invoices",
    apiEndpoints: ["GET /Invoices", "GET /CreditNotes"],
  },
  {
    capability: "Payments",
    scopes: ["accounting.payments.read"],
    action: "xero.payments.read",
    riskClass: "low_risk",
    mcpToolName: "xero_list_payments",
    apiEndpoints: ["GET /Payments", "GET /Overpayments"],
  },
  {
    capability: "Bank transactions",
    scopes: ["accounting.banktransactions.read"],
    action: "xero.bank_transactions.read",
    riskClass: "low_risk",
    mcpToolName: "xero_list_bank_transactions",
    apiEndpoints: ["GET /BankTransactions"],
  },
  {
    capability: "Profit & Loss",
    scopes: ["accounting.reports.profitandloss.read"],
    action: "xero.reports.pnl.read",
    riskClass: "low_risk",
    mcpToolName: "xero_profit_and_loss",
    apiEndpoints: ["GET /Reports/ProfitAndLoss"],
  },
  {
    capability: "Balance Sheet",
    scopes: ["accounting.reports.balancesheet.read"],
    action: "xero.reports.balance_sheet.read",
    riskClass: "low_risk",
    mcpToolName: "xero_balance_sheet",
    apiEndpoints: ["GET /Reports/BalanceSheet"],
  },
  {
    capability: "Aged receivables / payables",
    scopes: ["accounting.reports.aged.read"],
    action: "xero.reports.aged.read",
    riskClass: "low_risk",
    mcpToolName: "xero_aged_receivables",
    apiEndpoints: ["GET /Reports/AgedReceivablesByContact", "GET /Reports/AgedPayablesByContact"],
  },
  {
    capability: "Draft invoice create",
    scopes: ["accounting.invoices"],
    action: "xero.invoices.create",
    riskClass: "financial_action",
    mcpToolName: "xero_create_draft_invoice",
    apiEndpoints: ["POST /Invoices"],
    notes: "Code-ready; production execution blocked until writes_enabled.",
  },
  {
    capability: "Credit note create / allocate",
    scopes: ["accounting.invoices", "accounting.payments"],
    action: "xero.credit_notes.create",
    riskClass: "financial_action",
    mcpToolName: "xero_create_credit_note",
    apiEndpoints: ["POST /CreditNotes", "PUT /CreditNotes/{id}/Allocations"],
    notes: "Allocation may require multiple API calls; use execution plan.",
  },
  {
    capability: "Payment allocation",
    scopes: ["accounting.payments"],
    action: "xero.payments.allocate",
    riskClass: "financial_action",
    mcpToolName: "xero_allocate_payment",
    apiEndpoints: ["POST /Payments", "PUT /Payments"],
    notes: "Remittance workflow uses read → plan → allocate.",
  },
];

export function scopesForTier(tier: XeroScopeTier): string[] {
  if (tier === "read") return [...XERO_READ_SCOPES];
  return [...XERO_READ_SCOPES, ...XERO_WRITE_SCOPES];
}

export function tierFromGrantedScopes(granted: string[]): XeroScopeTier {
  const set = new Set(granted);
  const hasWrite = XERO_WRITE_SCOPES.some((scope) => set.has(scope));
  return hasWrite ? "write" : "read";
}

export function missingScopesForTier(
  granted: string[],
  target: XeroScopeTier,
): string[] {
  const required = new Set(scopesForTier(target));
  const have = new Set(granted);
  return [...required].filter((scope) => !have.has(scope));
}
