/**
 * Per-action production enablement gates for Xero WRITE beta.
 *
 * Distinction:
 * - IMPLEMENTED: code exists
 * - BETA_ENABLED: may be planned/confirmed in beta environments
 * - PRODUCTION_ENABLED: may execute against live Xero in production
 */

export type ActionReadiness = "NOT_IMPLEMENTED" | "IMPLEMENTED" | "BETA_ENABLED" | "PRODUCTION_ENABLED";

export type XeroWriteBetaGates = {
  draftInvoiceCreate: ActionReadiness;
  draftInvoiceUpdate: ActionReadiness;
  invoiceApprove: ActionReadiness;
  invoiceSend: ActionReadiness;
  combinedCreateApproveSend: ActionReadiness;
  draftCreditNoteCreate: ActionReadiness;
  creditNoteApprove: ActionReadiness;
  creditNoteAllocate: ActionReadiness;
  draftBillCreate: ActionReadiness;
  billApprove: ActionReadiness;
  paymentAllocate: ActionReadiness;
  contactCreate: ActionReadiness;
  documentVoid: ActionReadiness;
};

/** Production ceiling after WRITE beta sprint. */
export const XERO_WRITE_PRODUCTION_GATES: XeroWriteBetaGates = {
  draftInvoiceCreate: "PRODUCTION_ENABLED",
  draftInvoiceUpdate: "BETA_ENABLED",
  invoiceApprove: "PRODUCTION_ENABLED",
  invoiceSend: "IMPLEMENTED", // gated — no live send without explicit operator enable
  combinedCreateApproveSend: "IMPLEMENTED",
  draftCreditNoteCreate: "BETA_ENABLED",
  creditNoteApprove: "IMPLEMENTED",
  creditNoteAllocate: "IMPLEMENTED",
  draftBillCreate: "PRODUCTION_ENABLED",
  billApprove: "IMPLEMENTED",
  paymentAllocate: "IMPLEMENTED",
  contactCreate: "BETA_ENABLED",
  documentVoid: "IMPLEMENTED",
};

export function isActionProductionEnabled(
  gate: keyof XeroWriteBetaGates,
  gates: XeroWriteBetaGates = XERO_WRITE_PRODUCTION_GATES,
): boolean {
  return gates[gate] === "PRODUCTION_ENABLED";
}

export function isActionBetaEnabled(
  gate: keyof XeroWriteBetaGates,
  gates: XeroWriteBetaGates = XERO_WRITE_PRODUCTION_GATES,
): boolean {
  const readiness = gates[gate];
  return readiness === "BETA_ENABLED" || readiness === "PRODUCTION_ENABLED";
}

/** Maps requestedAction → beta gate key. */
export const ACTION_TO_BETA_GATE: Record<string, keyof XeroWriteBetaGates> = {
  "xero.invoices.create": "draftInvoiceCreate",
  "xero.invoices.update": "draftInvoiceUpdate",
  "xero.invoices.approve": "invoiceApprove",
  "xero.invoices.send": "invoiceSend",
  "xero.invoices.create_approve_send": "combinedCreateApproveSend",
  "xero.credit_notes.create_draft": "draftCreditNoteCreate",
  "xero.credit_notes.create": "creditNoteApprove",
  "xero.credit_notes.approve": "creditNoteApprove",
  "xero.credit_notes.allocate": "creditNoteAllocate",
  "xero.bills.create": "draftBillCreate",
  "xero.bills.approve": "billApprove",
  "xero.payments.allocate": "paymentAllocate",
  "xero.contacts.create": "contactCreate",
  "xero.invoice.void": "documentVoid",
  "xero.credit_note.void": "documentVoid",
  "xero.bill.void": "documentVoid",
};

export function betaGateForAction(action: string): keyof XeroWriteBetaGates | null {
  return ACTION_TO_BETA_GATE[action] ?? null;
}
