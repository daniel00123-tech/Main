/**
 * Human-readable Xero permission groups for Company Portal.
 * Platform safety ceiling always wins over tenant overrides.
 */

export type XeroPermissionGroup = {
  id: string;
  label: string;
  description?: string;
  actions: Array<{ action: string; label: string; platformBlocked?: boolean }>;
};

/** Actions that cannot be enabled by tenant override regardless of role grants. */
export const PLATFORM_XERO_SAFETY_CEILING = new Set([
  "xero.invoices.send",
  "xero.invoices.create_approve_send",
  "xero.payments.allocate",
  "xero.credit_notes.allocate",
  "xero.invoice.void",
  "xero.bill.void",
  "xero.credit_note.void",
]);

export const XERO_PERMISSION_GROUPS: XeroPermissionGroup[] = [
  {
    id: "xero_read",
    label: "Xero — Read",
    description: "View accounting data without making changes.",
    actions: [
      { action: "xero.invoices.read", label: "View invoices" },
      { action: "xero.invoices.search", label: "Search invoices" },
      { action: "xero.invoices.get", label: "View invoice details" },
      { action: "xero.contacts.read", label: "View contacts" },
      { action: "xero.contacts.search", label: "Search contacts" },
      { action: "xero.payments.read", label: "View payments" },
      { action: "xero.accounts.list", label: "View accounts" },
      { action: "xero.bank_transactions.read", label: "View bank transactions" },
      { action: "xero.reports.profit_and_loss", label: "View profit & loss" },
      { action: "xero.credit_notes.read", label: "View credit notes" },
      { action: "xero.organisation.read", label: "View organisation" },
    ],
  },
  {
    id: "xero_sales",
    label: "Xero — Sales",
    description: "Sales invoices and credit notes.",
    actions: [
      { action: "xero.invoices.create", label: "Create draft invoice" },
      { action: "xero.invoices.create_draft", label: "Create draft invoice (alias)" },
      { action: "xero.invoices.update_draft", label: "Update draft invoice" },
      { action: "xero.invoices.approve", label: "Approve / authorise invoice" },
      { action: "xero.invoices.send", label: "Send invoice by email", platformBlocked: true },
      { action: "xero.credit_notes.create_draft", label: "Create draft credit note" },
      { action: "xero.credit_notes.approve", label: "Approve credit note" },
    ],
  },
  {
    id: "xero_purchases",
    label: "Xero — Purchases",
    description: "Supplier bills.",
    actions: [
      { action: "xero.bills.create", label: "Create draft supplier bill" },
      { action: "xero.bills.approve", label: "Approve supplier bill" },
    ],
  },
  {
    id: "xero_contacts",
    label: "Xero — Contacts",
    actions: [{ action: "xero.contacts.create", label: "Create contact" }],
  },
  {
    id: "xero_payments",
    label: "Xero — Payments",
    description: "Record payment allocations in Xero (not bank transfers).",
    actions: [
      { action: "xero.payments.allocate", label: "Allocate payment", platformBlocked: true },
      { action: "xero.credit_notes.allocate", label: "Allocate credit note", platformBlocked: true },
    ],
  },
  {
    id: "xero_destructive",
    label: "Xero — Destructive",
    description: "Void documents. Requires strongest approval.",
    actions: [
      { action: "xero.invoice.void", label: "Void invoice", platformBlocked: true },
      { action: "xero.bill.void", label: "Void supplier bill", platformBlocked: true },
      { action: "xero.credit_note.void", label: "Void credit note", platformBlocked: true },
    ],
  },
];

export function isPlatformBlockedXeroAction(action: string): boolean {
  return PLATFORM_XERO_SAFETY_CEILING.has(action);
}
