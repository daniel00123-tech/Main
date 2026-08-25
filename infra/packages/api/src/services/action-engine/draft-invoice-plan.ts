import type { ActionPlanRecord, ActionTarget } from "@infra/shared";

export type DraftInvoiceLineInput = {
  description: string;
  quantity: number;
  unitAmount: number;
  accountCode?: string;
  taxType?: string;
};

export type DraftInvoicePlanInput = {
  contactId: string;
  contactName: string;
  lineItems: DraftInvoiceLineInput[];
  reference?: string;
  invoiceDate?: string;
  dueDate?: string;
  taxTreatment?: string;
  taxType?: string;
  taxTypeLabel?: string;
};

export function normalizeDraftInvoicePlanInput(input: {
  contactId: string;
  contactName: string;
  lineItems: DraftInvoiceLineInput[];
  reference?: string;
  invoiceDate?: string;
  dueDate?: string;
  date?: string;
  taxTreatment?: string;
  taxType?: string;
  taxTypeLabel?: string;
}): DraftInvoicePlanInput {
  return {
    contactId: input.contactId,
    contactName: input.contactName,
    lineItems: input.lineItems,
    reference: input.reference,
    invoiceDate: input.invoiceDate ?? input.date,
    dueDate: input.dueDate,
    taxTreatment: input.taxTreatment,
    taxType: input.taxType,
    taxTypeLabel: input.taxTypeLabel,
  };
}

export function buildDraftInvoiceProposedState(input: DraftInvoicePlanInput) {
  const lineItems = input.lineItems.map((row) => ({
    description: row.description,
    quantity: row.quantity,
    unitAmount: row.unitAmount,
    accountCode: row.accountCode,
    taxType: row.taxType,
  }));
  const total = lineItems.reduce((sum, row) => sum + row.quantity * row.unitAmount, 0);
  return {
    action: "create_draft_invoice",
    type: "ACCREC",
    status: "DRAFT",
    contactId: input.contactId,
    contactName: input.contactName,
    lineItems,
    reference: input.reference ?? null,
    invoiceDate: input.invoiceDate ?? null,
    dueDate: input.dueDate ?? null,
    date: input.invoiceDate ?? null,
    taxTreatment: input.taxTreatment ?? null,
    taxType: input.taxType ?? null,
    taxTypeLabel: input.taxTypeLabel ?? null,
    total,
  };
}

export function buildDraftInvoiceReviewSummary(proposed: Record<string, unknown>) {
  const lineItems = Array.isArray(proposed.lineItems)
    ? (proposed.lineItems as DraftInvoiceLineInput[])
    : [];
  const first = lineItems[0];
  const total = lineItems.reduce(
    (sum, row) => sum + Number(row.quantity ?? 0) * Number(row.unitAmount ?? 0),
    0,
  );
  return {
    customer: proposed.contactName ? String(proposed.contactName) : null,
    contactId: proposed.contactId ? String(proposed.contactId) : null,
    invoiceStatus: "DRAFT",
    invoiceDate: proposed.invoiceDate ?? proposed.date ?? null,
    dueDate: proposed.dueDate ?? null,
    reference: proposed.reference ?? null,
    lineDescription: first?.description ?? null,
    quantity: first?.quantity ?? null,
    unitAmount: first?.unitAmount ?? null,
    accountCode: first?.accountCode ?? null,
    taxTreatment: proposed.taxTreatment ?? null,
    taxType: proposed.taxType ?? null,
    taxTypeLabel: proposed.taxTypeLabel ?? null,
    total,
    currencyCode: null,
  };
}

export function draftInvoiceReviewFromPlan(plan: ActionPlanRecord) {
  const proposed = plan.targets[0]?.proposedState ?? {};
  return {
    summary: plan.summary,
    review: buildDraftInvoiceReviewSummary(proposed),
    targets: plan.targets,
  };
}

export function draftInvoicePayloadFromProposedState(plan: ActionPlanRecord): {
  contactId: string;
  lineItems: DraftInvoiceLineInput[];
  reference?: string;
  date?: string;
  dueDate?: string;
} {
  const target = plan.targets[0];
  if (!target) throw new Error("Plan has no targets.");
  const proposed = target.proposedState ?? {};
  const invoiceDate = proposed.invoiceDate ?? proposed.date;
  return {
    contactId: String(proposed.contactId ?? target.targetId),
    lineItems: Array.isArray(proposed.lineItems)
      ? (proposed.lineItems as DraftInvoiceLineInput[])
      : [],
    reference: proposed.reference ? String(proposed.reference) : undefined,
    date: invoiceDate ? String(invoiceDate) : undefined,
    dueDate: proposed.dueDate ? String(proposed.dueDate) : undefined,
  };
}

export function draftInvoiceExpectedFromProposed(target: ActionTarget) {
  const proposed = target.proposedState ?? {};
  const lineItems = Array.isArray(proposed.lineItems)
    ? (proposed.lineItems as DraftInvoiceLineInput[])
    : [];
  const total = lineItems.reduce(
    (sum, row) => sum + Number(row.quantity ?? 0) * Number(row.unitAmount ?? 0),
    0,
  );
  return {
    contactId: String(proposed.contactId ?? target.targetId),
    type: "ACCREC" as const,
    status: "DRAFT" as const,
    total,
    reference: proposed.reference ? String(proposed.reference) : null,
    lineItemDescription: lineItems[0]?.description ? String(lineItems[0].description) : null,
    dueDate: proposed.dueDate ? String(proposed.dueDate) : null,
    invoiceDate: proposed.invoiceDate ?? proposed.date ? String(proposed.invoiceDate ?? proposed.date) : null,
    taxType: lineItems[0]?.taxType ? String(lineItems[0].taxType) : proposed.taxType ? String(proposed.taxType) : null,
    accountCode: lineItems[0]?.accountCode ? String(lineItems[0].accountCode) : null,
  };
}
