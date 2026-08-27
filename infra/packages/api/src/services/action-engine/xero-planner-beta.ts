/**
 * Xero WRITE beta planners — approve, send, bills, credit notes, contacts, workflows.
 */

import type { ActionTarget, FinancialImpact } from "@infra/shared";
import type { Env } from "../../env";
import { XERO_AUTH } from "@infra/shared";
import { xeroGetJson, isSalesTransactionType } from "@infra/xero-core";
import { getValidXeroAccessToken } from "../xero";
import {
  buildDraftInvoiceProposedState,
  defaultDraftInvoiceDates,
  normalizeDraftInvoicePlanInput,
  type DraftInvoiceLineInput,
} from "./draft-invoice-plan";
import { resolveXeroContactForDraftInvoice } from "./xero-contact-resolve";
import {
  resolveSalesAccountCodeWithFetch,
  resolveXeroTaxTypeForDraftInvoice,
  resolveExpenseAccountCodeWithFetch,
} from "@infra/xero-core";

type XeroInvoiceRow = {
  InvoiceID?: string;
  InvoiceNumber?: string;
  Reference?: string;
  Type?: string;
  Status?: string;
  Total?: number;
  TotalTax?: number;
  SubTotal?: number;
  AmountDue?: number;
  CurrencyCode?: string;
  Date?: string;
  DateString?: string;
  DueDate?: string;
  DueDateString?: string;
  UpdatedDateUTC?: string;
  Contact?: { ContactID?: string; Name?: string; EmailAddress?: string };
  LineItems?: Array<Record<string, unknown>>;
};

async function token(env: Env, companyId: string, instanceId: string, actor: string) {
  return getValidXeroAccessToken({ env, companyId, instanceId, actor, reason: "mcp_resolve" });
}

function xeroConfig(t: { accessToken: string; tenantId: string }) {
  return { accessToken: t.accessToken, tenantId: t.tenantId, apiBaseUrl: XERO_AUTH.apiBaseUrl };
}

async function fetchInvoice(
  t: { accessToken: string; tenantId: string },
  input: { invoiceId?: string; invoiceNumber?: string },
): Promise<XeroInvoiceRow | null> {
  if (input.invoiceId) {
    const body = await xeroGetJson<{ Invoices?: XeroInvoiceRow[] }>(
      xeroConfig(t),
      `/Invoices/${input.invoiceId}`,
    );
    return body.Invoices?.[0] ?? null;
  }
  if (input.invoiceNumber) {
    const body = await xeroGetJson<{ Invoices?: XeroInvoiceRow[] }>(
      xeroConfig(t),
      "/Invoices",
      { where: `InvoiceNumber=="${input.invoiceNumber.replace(/"/g, "")}"` },
    );
    return body.Invoices?.[0] ?? null;
  }
  return null;
}

function stateFingerprint(invoice: XeroInvoiceRow): Record<string, unknown> {
  return {
    status: invoice.Status ?? null,
    total: invoice.Total ?? null,
    amountDue: invoice.AmountDue ?? null,
    updatedDateUtc: invoice.UpdatedDateUTC ?? null,
    reference: invoice.Reference ?? null,
  };
}

function invoiceReview(invoice: XeroInvoiceRow) {
  return {
    customer: invoice.Contact?.Name ?? null,
    contactId: invoice.Contact?.ContactID ?? null,
    invoiceNumber: invoice.InvoiceNumber ?? null,
    reference: invoice.Reference ?? null,
    invoiceDate: invoice.DateString?.slice(0, 10) ?? null,
    dueDate: invoice.DueDateString?.slice(0, 10) ?? null,
    subtotal: invoice.SubTotal ?? null,
    totalTax: invoice.TotalTax ?? null,
    total: invoice.Total ?? null,
    status: invoice.Status ?? null,
    type: invoice.Type ?? null,
    lineItems: invoice.LineItems ?? [],
    emailAddress: invoice.Contact?.EmailAddress ?? null,
  };
}

function invalidTarget(
  targetId: string,
  humanRef: string,
  targetType: string,
  validation: ActionTarget["validation"],
  detail: string,
  currentState: Record<string, unknown> = {},
): ActionTarget {
  return {
    targetId,
    targetType,
    humanRef,
    currentState,
    proposedState: {},
    validation,
    validationDetail: detail,
  };
}

export async function planXeroApproveInvoice(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  actor: string;
  invoiceId?: string;
  invoiceNumber?: string;
}): Promise<{ targets: ActionTarget[]; summary: string; financialImpact: FinancialImpact; review: Record<string, unknown> }> {
  const tok = await token(input.env, input.companyId, input.instanceId, input.actor);
  if (!tok.ok) throw new Error(tok.body.error);
  const invoice = await fetchInvoice(tok, {
    invoiceId: input.invoiceId,
    invoiceNumber: input.invoiceNumber,
  });
  const id = String(invoice?.InvoiceID ?? input.invoiceId ?? input.invoiceNumber ?? "unknown");
  const ref = String(invoice?.InvoiceNumber ?? input.invoiceNumber ?? id);

  if (!invoice) {
    return {
      targets: [invalidTarget(id, ref, "invoice", "not_found", "Invoice not found in Xero.")],
      summary: "Approve invoice plan failed — invoice not found.",
      financialImpact: { currencyCode: null, totalAmount: null, direction: "debit", itemCount: 0 },
      review: {},
    };
  }

  const type = String(invoice.Type ?? "");
  const status = String(invoice.Status ?? "");
  if (!isSalesTransactionType(type)) {
    return {
      targets: [
        invalidTarget(id, ref, "invoice", "wrong_type", `${type} is not a sales invoice (ACCREC).`, stateFingerprint(invoice)),
      ],
      summary: "Approve invoice plan failed — not a sales invoice.",
      financialImpact: { currencyCode: invoice.CurrencyCode ?? null, totalAmount: Number(invoice.Total ?? 0), direction: "debit", itemCount: 1 },
      review: invoiceReview(invoice),
    };
  }
  if (status !== "DRAFT") {
    return {
      targets: [
        invalidTarget(id, ref, "invoice", "wrong_status", `Invoice status is ${status}; only DRAFT invoices can be approved.`, stateFingerprint(invoice)),
      ],
      summary: `Approve invoice plan failed — status is ${status}.`,
      financialImpact: { currencyCode: invoice.CurrencyCode ?? null, totalAmount: Number(invoice.Total ?? 0), direction: "debit", itemCount: 1 },
      review: invoiceReview(invoice),
    };
  }

  const review = invoiceReview(invoice);
  const target: ActionTarget = {
    targetId: id,
    targetType: "invoice",
    humanRef: ref,
    currentState: { ...stateFingerprint(invoice), ...review },
    proposedState: {
      action: "approve_sales_invoice",
      invoiceId: id,
      resultingStatus: "AUTHORISED",
      stateFingerprint: stateFingerprint(invoice),
    },
    amount: Number(invoice.Total ?? 0),
    currencyCode: invoice.CurrencyCode ?? null,
    validation: "valid",
  };

  return {
    targets: [target],
    summary: `Approve sales invoice ${ref} for ${invoice.Contact?.Name ?? "customer"} totalling ${invoice.Total ?? 0}.`,
    financialImpact: {
      currencyCode: invoice.CurrencyCode ?? null,
      totalAmount: Number(invoice.Total ?? 0),
      direction: "debit",
      itemCount: 1,
    },
    review: { ...review, resultingStatus: "AUTHORISED", riskWarning: "This commits the invoice in Xero accounting." },
  };
}

export async function planXeroSendInvoice(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  actor: string;
  invoiceId?: string;
  invoiceNumber?: string;
}): Promise<{ targets: ActionTarget[]; summary: string; financialImpact: FinancialImpact; review: Record<string, unknown> }> {
  const tok = await token(input.env, input.companyId, input.instanceId, input.actor);
  if (!tok.ok) throw new Error(tok.body.error);
  const invoice = await fetchInvoice(tok, {
    invoiceId: input.invoiceId,
    invoiceNumber: input.invoiceNumber,
  });
  const id = String(invoice?.InvoiceID ?? input.invoiceId ?? input.invoiceNumber ?? "unknown");
  const ref = String(invoice?.InvoiceNumber ?? input.invoiceNumber ?? id);

  if (!invoice) {
    return {
      targets: [invalidTarget(id, ref, "invoice", "not_found", "Invoice not found in Xero.")],
      summary: "Send invoice plan failed — invoice not found.",
      financialImpact: { currencyCode: null, totalAmount: null, direction: "neutral", itemCount: 0 },
      review: {},
    };
  }

  const type = String(invoice.Type ?? "");
  const status = String(invoice.Status ?? "");
  if (!isSalesTransactionType(type)) {
    return {
      targets: [invalidTarget(id, ref, "invoice", "wrong_type", `${type} is not a sales invoice.`, stateFingerprint(invoice))],
      summary: "Send invoice plan failed — not a sales invoice.",
      financialImpact: { currencyCode: invoice.CurrencyCode ?? null, totalAmount: Number(invoice.Total ?? 0), direction: "neutral", itemCount: 1 },
      review: invoiceReview(invoice),
    };
  }
  if (status !== "AUTHORISED" && status !== "SUBMITTED") {
    return {
      targets: [
        invalidTarget(id, ref, "invoice", "wrong_status", `Invoice must be authorised before sending (current: ${status}).`, stateFingerprint(invoice)),
      ],
      summary: `Send invoice plan failed — invoice is ${status}.`,
      financialImpact: { currencyCode: invoice.CurrencyCode ?? null, totalAmount: Number(invoice.Total ?? 0), direction: "neutral", itemCount: 1 },
      review: invoiceReview(invoice),
    };
  }

  const email = invoice.Contact?.EmailAddress?.trim() ?? "";
  if (!email) {
    return {
      targets: [
        invalidTarget(id, ref, "invoice", "reference_required", "No email address on file for this customer. Cannot send.", stateFingerprint(invoice)),
      ],
      summary: "Send invoice plan failed — no destination email.",
      financialImpact: { currencyCode: invoice.CurrencyCode ?? null, totalAmount: Number(invoice.Total ?? 0), direction: "neutral", itemCount: 1 },
      review: invoiceReview(invoice),
    };
  }

  const review = invoiceReview(invoice);
  const target: ActionTarget = {
    targetId: id,
    targetType: "invoice",
    humanRef: ref,
    currentState: { ...stateFingerprint(invoice), ...review },
    proposedState: {
      action: "send_sales_invoice",
      invoiceId: id,
      destinationEmail: email,
      stateFingerprint: stateFingerprint(invoice),
    },
    amount: Number(invoice.Total ?? 0),
    currencyCode: invoice.CurrencyCode ?? null,
    validation: "valid",
  };

  return {
    targets: [target],
    summary: `Send invoice ${ref} for ${formatMoney(Number(invoice.Total ?? 0))} to ${email}.`,
    financialImpact: {
      currencyCode: invoice.CurrencyCode ?? null,
      totalAmount: Number(invoice.Total ?? 0),
      direction: "neutral",
      itemCount: 1,
    },
    review: { ...review, destinationEmail: email, riskWarning: "This sends the invoice to an external recipient." },
  };
}

function formatMoney(n: number): string {
  return `£${n.toFixed(2)}`;
}

export async function planXeroDraftBill(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  actor: string;
  contactId?: string;
  contactName?: string;
  lineItems: DraftInvoiceLineInput[];
  reference?: string;
  billDate?: string;
  dueDate?: string;
  taxTreatment?: string;
}): Promise<{ targets: ActionTarget[]; summary: string; financialImpact: FinancialImpact; review: Record<string, unknown> }> {
  const tok = await token(input.env, input.companyId, input.instanceId, input.actor);
  if (!tok.ok) throw new Error(tok.body.error);
  const cfg = xeroConfig(tok);
  const dates = defaultDraftInvoiceDates();
  const billDate = input.billDate ?? dates.invoiceDate;
  const dueDate = input.dueDate ?? dates.dueDate;

  const resolvedLineItems: DraftInvoiceLineInput[] = [];
  for (const row of input.lineItems) {
    const account = await resolveExpenseAccountCodeWithFetch(cfg, {
      accountCode: row.accountCode,
      accountName: row.accountName ?? (row.accountCode?.trim() ? undefined : "Expense"),
    });
    resolvedLineItems.push({ ...row, accountCode: account.code });
  }

  const resolved = await resolveXeroContactForDraftInvoice({
    accessToken: tok.accessToken,
    tenantId: tok.tenantId,
    contactId: input.contactId,
    contactName: input.contactName,
  });

  if (!resolved.ok) {
    const ref = input.contactId ?? input.contactName ?? "supplier";
    return {
      targets: [{
        targetId: ref,
        targetType: "contact",
        humanRef: ref,
        currentState: resolved.validation === "ambiguous" ? { candidates: resolved.candidates ?? [] } : {},
        proposedState: {},
        validation: resolved.validation === "ambiguous" ? "ambiguous" : "not_found",
        validationDetail: resolved.validationDetail,
      }],
      summary: "Draft supplier bill plan failed — supplier not found.",
      financialImpact: { currencyCode: null, totalAmount: null, direction: "debit", itemCount: 0 },
      review: { documentKind: "SUPPLIER BILL" },
    };
  }

  const tax = await resolveXeroTaxTypeForDraftInvoice(cfg, {
    taxTreatment: input.taxTreatment ?? "No VAT",
    accountCode: resolvedLineItems[0]?.accountCode,
  });

  const normalized = normalizeDraftInvoicePlanInput({
    contactId: resolved.contact.contactId,
    contactName: resolved.contact.contactName,
    lineItems: resolvedLineItems.map((r) => ({ ...r, taxType: r.taxType ?? tax.taxType })),
    reference: input.reference,
    invoiceDate: billDate,
    dueDate,
    taxTreatment: input.taxTreatment,
    taxType: tax.taxType,
    taxTypeLabel: tax.label,
  });

  const proposed = buildDraftInvoiceProposedState(normalized);
  proposed.type = "ACCPAY";
  proposed.action = "create_draft_bill";
  const total = Number(proposed.total ?? 0);

  const target: ActionTarget = {
    targetId: resolved.contact.contactId,
    targetType: "draft_bill",
    humanRef: resolved.contact.contactName,
    currentState: { contactId: resolved.contact.contactId, contactName: resolved.contact.contactName },
    proposedState: { ...proposed, documentKind: "SUPPLIER BILL" },
    amount: total,
    validation: "valid",
  };

  return {
    targets: [target],
    summary: `Create draft supplier bill for ${resolved.contact.contactName} totalling ${total}.`,
    financialImpact: { currencyCode: null, totalAmount: total, direction: "debit", itemCount: 1 },
    review: { documentKind: "SUPPLIER BILL", supplier: resolved.contact.contactName, total, billDate, dueDate },
  };
}

export async function planXeroApproveBill(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  actor: string;
  invoiceId?: string;
  invoiceNumber?: string;
}): Promise<{ targets: ActionTarget[]; summary: string; financialImpact: FinancialImpact; review: Record<string, unknown> }> {
  const tok = await token(input.env, input.companyId, input.instanceId, input.actor);
  if (!tok.ok) throw new Error(tok.body.error);
  const invoice = await fetchInvoice(tok, { invoiceId: input.invoiceId, invoiceNumber: input.invoiceNumber });
  const id = String(invoice?.InvoiceID ?? input.invoiceId ?? "unknown");
  const ref = String(invoice?.InvoiceNumber ?? input.invoiceNumber ?? id);

  if (!invoice || String(invoice.Type ?? "") !== "ACCPAY") {
    return {
      targets: [invalidTarget(id, ref, "draft_bill", invoice ? "wrong_type" : "not_found", invoice ? "Not a supplier bill (ACCPAY)." : "Bill not found.")],
      summary: "Approve supplier bill plan failed.",
      financialImpact: { currencyCode: null, totalAmount: null, direction: "debit", itemCount: 0 },
      review: { documentKind: "SUPPLIER BILL" },
    };
  }
  if (String(invoice.Status ?? "") !== "DRAFT") {
    return {
      targets: [invalidTarget(id, ref, "draft_bill", "wrong_status", `Bill status is ${invoice.Status}; only DRAFT bills can be approved.`, stateFingerprint(invoice))],
      summary: "Approve supplier bill plan failed — wrong status.",
      financialImpact: { currencyCode: invoice.CurrencyCode ?? null, totalAmount: Number(invoice.Total ?? 0), direction: "debit", itemCount: 1 },
      review: { documentKind: "SUPPLIER BILL", ...invoiceReview(invoice) },
    };
  }

  const review = { documentKind: "SUPPLIER BILL" as const, ...invoiceReview(invoice), resultingStatus: "AUTHORISED" };
  return {
    targets: [{
      targetId: id,
      targetType: "draft_bill",
      humanRef: ref,
      currentState: { ...stateFingerprint(invoice), ...review },
      proposedState: { action: "approve_supplier_bill", invoiceId: id, resultingStatus: "AUTHORISED", stateFingerprint: stateFingerprint(invoice) },
      amount: Number(invoice.Total ?? 0),
      currencyCode: invoice.CurrencyCode ?? null,
      validation: "valid",
    }],
    summary: `Approve supplier bill ${ref} — total liability ${invoice.Total ?? 0}.`,
    financialImpact: { currencyCode: invoice.CurrencyCode ?? null, totalAmount: Number(invoice.Total ?? 0), direction: "debit", itemCount: 1 },
    review,
  };
}

export async function planXeroDraftCreditNote(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  actor: string;
  contactId?: string;
  contactName?: string;
  lineItems: DraftInvoiceLineInput[];
  reference?: string;
  taxTreatment?: string;
}): Promise<{ targets: ActionTarget[]; summary: string; financialImpact: FinancialImpact; review: Record<string, unknown> }> {
  const tok = await token(input.env, input.companyId, input.instanceId, input.actor);
  if (!tok.ok) throw new Error(tok.body.error);
  const cfg = xeroConfig(tok);

  const resolved = await resolveXeroContactForDraftInvoice({
    accessToken: tok.accessToken,
    tenantId: tok.tenantId,
    contactId: input.contactId,
    contactName: input.contactName,
  });
  if (!resolved.ok) {
    return {
      targets: [{
        targetId: input.contactName ?? "contact",
        targetType: "contact",
        humanRef: input.contactName ?? "contact",
        currentState: {},
        proposedState: {},
        validation: "not_found",
        validationDetail: resolved.validationDetail,
      }],
      summary: "Draft credit note plan failed — customer not found.",
      financialImpact: { currencyCode: null, totalAmount: null, direction: "credit", itemCount: 0 },
      review: {},
    };
  }

  const lineItems: DraftInvoiceLineInput[] = [];
  for (const row of input.lineItems) {
    const account = await resolveSalesAccountCodeWithFetch(cfg, { accountCode: row.accountCode, accountName: row.accountName ?? "Sales" });
    lineItems.push({ ...row, accountCode: account.code });
  }
  const tax = await resolveXeroTaxTypeForDraftInvoice(cfg, { taxTreatment: input.taxTreatment ?? "No VAT", accountCode: lineItems[0]?.accountCode });
  const total = lineItems.reduce((s, r) => s + r.quantity * r.unitAmount, 0);

  const target: ActionTarget = {
    targetId: resolved.contact.contactId,
    targetType: "draft_credit_note",
    humanRef: resolved.contact.contactName,
    currentState: { contactId: resolved.contact.contactId, contactName: resolved.contact.contactName },
    proposedState: {
      action: "create_draft_credit_note",
      contactId: resolved.contact.contactId,
      contactName: resolved.contact.contactName,
      lineItems: lineItems.map((r) => ({ ...r, taxType: r.taxType ?? tax.taxType })),
      reference: input.reference ?? null,
      taxType: tax.taxType,
      status: "DRAFT",
      total,
    },
    amount: total,
    validation: "valid",
  };

  return {
    targets: [target],
    summary: `Create draft sales credit note for ${resolved.contact.contactName} totalling ${total}.`,
    financialImpact: { currencyCode: null, totalAmount: total, direction: "credit", itemCount: 1 },
    review: { customer: resolved.contact.contactName, total, reference: input.reference ?? null },
  };
}

export async function planXeroCreateContact(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  actor: string;
  name: string;
  email?: string;
  phone?: string;
  isCustomer?: boolean;
  isSupplier?: boolean;
}): Promise<{ targets: ActionTarget[]; summary: string; financialImpact: FinancialImpact; review: Record<string, unknown> }> {
  const tok = await token(input.env, input.companyId, input.instanceId, input.actor);
  if (!tok.ok) throw new Error(tok.body.error);

  const name = input.name.trim();
  if (!name) {
    return {
      targets: [invalidTarget("contact", "contact", "contact", "not_found", "Contact name is required.")],
      summary: "Create contact plan failed — name required.",
      financialImpact: { currencyCode: null, totalAmount: null, direction: "neutral", itemCount: 0 },
      review: {},
    };
  }

  const body = await xeroGetJson<{ Contacts?: Array<{ ContactID?: string; Name?: string }> }>(
    xeroConfig(tok),
    "/Contacts",
    { where: `Name.Contains("${name.replace(/"/g, "")}")` },
  );
  const matches = (body.Contacts ?? []).filter((c) =>
    String(c.Name ?? "").toLowerCase() === name.toLowerCase(),
  );
  if (matches.length > 0) {
    return {
      targets: [{
        targetId: String(matches[0]?.ContactID ?? name),
        targetType: "contact",
        humanRef: name,
        currentState: { existingMatches: matches },
        proposedState: {},
        validation: "ambiguous",
        validationDetail: `A contact named "${matches[0]?.Name}" already exists in Xero.`,
      }],
      summary: "Create contact plan blocked — possible duplicate.",
      financialImpact: { currencyCode: null, totalAmount: null, direction: "neutral", itemCount: 0 },
      review: { name, email: input.email ?? null },
    };
  }

  const target: ActionTarget = {
    targetId: `new:${name}`,
    targetType: "contact",
    humanRef: name,
    currentState: {},
    proposedState: {
      action: "create_contact",
      name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      isCustomer: input.isCustomer ?? true,
      isSupplier: input.isSupplier ?? false,
    },
    validation: "valid",
  };

  return {
    targets: [target],
    summary: `Create Xero contact "${name}".`,
    financialImpact: { currencyCode: null, totalAmount: null, direction: "neutral", itemCount: 1 },
    review: { name, email: input.email ?? null, phone: input.phone ?? null },
  };
}

export async function planXeroCombinedCreateApproveSend(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  actor: string;
  contactId?: string;
  contactName?: string;
  lineItems: DraftInvoiceLineInput[];
  reference?: string;
  invoiceDate?: string;
  dueDate?: string;
  taxTreatment?: string;
}): Promise<{ targets: ActionTarget[]; summary: string; financialImpact: FinancialImpact; review: Record<string, unknown> }> {
  const draft = await planXeroDraftInvoiceBeta(input);
  if (draft.targets[0]?.validation !== "valid") {
    return { ...draft, review: { ...draft.review, workflowSteps: [] } };
  }

  const proposed = draft.targets[0]?.proposedState ?? {};
  const email = draft.review?.emailAddress ?? null;
  const steps = [
    { step: 1, action: "create_draft", label: "Create draft sales invoice" },
    { step: 2, action: "approve", label: "Approve invoice (AUTHORISED)" },
    { step: 3, action: "send", label: email ? `Send to ${email}` : "Send (requires email on contact)" },
  ];

  if (!email) {
    return {
      targets: [{
        ...draft.targets[0]!,
        validation: "reference_required" as const,
        validationDetail: "Combined workflow requires a customer email address for sending.",
      }],
      summary: "Combined workflow plan failed — no send destination email.",
      financialImpact: draft.financialImpact,
      review: { workflowSteps: steps, ...draft.review },
    };
  }

  return {
    targets: [{
      ...draft.targets[0]!,
      proposedState: {
        ...proposed,
        action: "create_approve_send_workflow",
        workflowSteps: steps,
        destinationEmail: email,
      },
    }],
    summary: `Create, approve, and send sales invoice for ${draft.review?.customer ?? "customer"} totalling ${draft.financialImpact.totalAmount ?? 0}.`,
    financialImpact: draft.financialImpact,
    review: { workflowSteps: steps, destinationEmail: email, ...draft.review, riskWarning: "This creates, commits, and sends an invoice externally." },
  };
}

async function planXeroDraftInvoiceBeta(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  actor: string;
  contactId?: string;
  contactName?: string;
  lineItems: DraftInvoiceLineInput[];
  reference?: string;
  invoiceDate?: string;
  dueDate?: string;
  taxTreatment?: string;
}) {
  const { planXeroDraftInvoice } = await import("./xero-planner");
  const planned = await planXeroDraftInvoice(input);
  let email: string | null = null;
  const contactId = planned.targets[0]?.targetId;
  if (contactId) {
    const tok = await token(input.env, input.companyId, input.instanceId, input.actor);
    if (tok.ok) {
      const contactBody = await xeroGetJson<{ Contacts?: Array<{ EmailAddress?: string }> }>(
        xeroConfig(tok),
        `/Contacts/${contactId}`,
      );
      email = contactBody.Contacts?.[0]?.EmailAddress?.trim() ?? null;
    }
  }
  return {
    ...planned,
    review: {
      ...(planned.review ?? {}),
      emailAddress: email,
      customer: planned.review?.customer ?? input.contactName ?? null,
    },
  };
}

export { fetchInvoice, stateFingerprint, invoiceReview };

export async function planXeroUpdateDraftInvoice(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  actor: string;
  invoiceId: string;
  patch: {
    reference?: string;
    invoiceDate?: string;
    dueDate?: string;
    lineItems?: DraftInvoiceLineInput[];
  };
}): Promise<{ targets: ActionTarget[]; summary: string; financialImpact: FinancialImpact; review: Record<string, unknown> }> {
  const tok = await token(input.env, input.companyId, input.instanceId, input.actor);
  if (!tok.ok) throw new Error(tok.body.error);
  const invoice = await fetchInvoice(tok, { invoiceId: input.invoiceId });
  const id = String(invoice?.InvoiceID ?? input.invoiceId);
  const ref = String(invoice?.InvoiceNumber ?? id);

  if (!invoice) {
    return {
      targets: [invalidTarget(id, ref, "invoice", "not_found", "Invoice not found in Xero.")],
      summary: "Update draft invoice plan failed — not found.",
      financialImpact: { currencyCode: null, totalAmount: null, direction: "debit", itemCount: 0 },
      review: {},
    };
  }
  const type = String(invoice.Type ?? "");
  const status = String(invoice.Status ?? "");
  if (type !== "ACCREC") {
    return {
      targets: [invalidTarget(id, ref, "invoice", "wrong_type", "Only sales invoices (ACCREC) can be updated with this action.")],
      summary: "Update draft invoice plan failed — wrong document type.",
      financialImpact: { currencyCode: null, totalAmount: null, direction: "debit", itemCount: 0 },
      review: {},
    };
  }
  if (status !== "DRAFT") {
    return {
      targets: [invalidTarget(id, ref, "invoice", "wrong_status", `Invoice status is ${status}; only DRAFT invoices can be edited.`, stateFingerprint(invoice))],
      summary: "Update draft invoice plan failed — not a draft.",
      financialImpact: { currencyCode: invoice.CurrencyCode ?? null, totalAmount: Number(invoice.Total ?? 0), direction: "debit", itemCount: 1 },
      review: invoiceReview(invoice),
    };
  }

  const before = invoiceReview(invoice);
  const cfg = xeroConfig(tok);
  let proposedLines = input.patch.lineItems;
  if (proposedLines?.length) {
    const resolved: DraftInvoiceLineInput[] = [];
    for (const row of proposedLines) {
      const account = await resolveSalesAccountCodeWithFetch(cfg, { accountCode: row.accountCode, accountName: row.accountName ?? "Sales" });
      resolved.push({ ...row, accountCode: account.code });
    }
    proposedLines = resolved;
  }
  const proposedTotal = proposedLines?.length
    ? proposedLines.reduce((s, r) => s + r.quantity * r.unitAmount, 0)
    : Number(invoice.Total ?? 0);

  const after = {
    ...before,
    reference: input.patch.reference ?? before.reference,
    invoiceDate: input.patch.invoiceDate ?? before.invoiceDate,
    dueDate: input.patch.dueDate ?? before.dueDate,
    total: proposedTotal,
    lineItems: proposedLines ?? before.lineItems,
  };

  const target: ActionTarget = {
    targetId: id,
    targetType: "draft_invoice",
    humanRef: ref,
    currentState: { ...stateFingerprint(invoice), ...before, documentKind: "SALES INVOICE" },
    proposedState: {
      action: "update_draft_invoice",
      invoiceId: id,
      type: "ACCREC",
      patch: {
        reference: input.patch.reference,
        date: input.patch.invoiceDate,
        dueDate: input.patch.dueDate,
        lineItems: proposedLines,
      },
      after,
      stateFingerprint: stateFingerprint(invoice),
    },
    amount: proposedTotal,
    currencyCode: invoice.CurrencyCode ?? null,
    validation: "valid",
  };

  return {
    targets: [target],
    summary: `Update draft invoice ${ref} — total ${proposedTotal}.`,
    financialImpact: { currencyCode: invoice.CurrencyCode ?? null, totalAmount: proposedTotal, direction: "debit", itemCount: 1 },
    review: { before, after, changes: diffInvoiceReview(before, after) },
  };
}

function diffInvoiceReview(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const changes: string[] = [];
  for (const key of ["reference", "invoiceDate", "dueDate", "total"]) {
    if (before[key] !== after[key]) changes.push(`${key}: ${String(before[key] ?? "—")} → ${String(after[key] ?? "—")}`);
  }
  return changes;
}

export async function planXeroApproveCreditNote(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  actor: string;
  creditNoteId?: string;
  creditNoteNumber?: string;
}): Promise<{ targets: ActionTarget[]; summary: string; financialImpact: FinancialImpact; review: Record<string, unknown> }> {
  const tok = await token(input.env, input.companyId, input.instanceId, input.actor);
  if (!tok.ok) throw new Error(tok.body.error);
  let cn: Record<string, unknown> | null = null;
  if (input.creditNoteId) {
    const body = await xeroGetJson<{ CreditNotes?: Array<Record<string, unknown>> }>(xeroConfig(tok), `/CreditNotes/${input.creditNoteId}`);
    cn = body.CreditNotes?.[0] ?? null;
  }
  const id = String(cn?.CreditNoteID ?? input.creditNoteId ?? "unknown");
  const ref = String(cn?.CreditNoteNumber ?? input.creditNoteNumber ?? id);
  if (!cn) {
    return {
      targets: [invalidTarget(id, ref, "credit_note", "not_found", "Credit note not found.")],
      summary: "Approve credit note plan failed.",
      financialImpact: { currencyCode: null, totalAmount: null, direction: "credit", itemCount: 0 },
      review: { documentKind: "SALES CREDIT NOTE" },
    };
  }
  const type = String(cn.Type ?? "");
  const status = String(cn.Status ?? "");
  if (type !== "ACCRECCREDIT") {
    return {
      targets: [invalidTarget(id, ref, "credit_note", "wrong_type", "Only sales credit notes (ACCRECCREDIT) supported.")],
      summary: "Approve credit note plan failed — wrong type.",
      financialImpact: { currencyCode: null, totalAmount: null, direction: "credit", itemCount: 0 },
      review: { documentKind: "SALES CREDIT NOTE" },
    };
  }
  if (status !== "DRAFT") {
    return {
      targets: [invalidTarget(id, ref, "credit_note", "wrong_status", `Credit note status is ${status}; only DRAFT can be approved.`)],
      summary: "Approve credit note plan failed — wrong status.",
      financialImpact: { currencyCode: cn.CurrencyCode ? String(cn.CurrencyCode) : null, totalAmount: Number(cn.Total ?? 0), direction: "credit", itemCount: 1 },
      review: { documentKind: "SALES CREDIT NOTE", status },
    };
  }
  const review = {
    documentKind: "SALES CREDIT NOTE" as const,
    customer: (cn.Contact as { Name?: string })?.Name ?? null,
    creditNoteNumber: ref,
    reference: cn.Reference ?? null,
    total: cn.Total ?? null,
    status,
    resultingStatus: "AUTHORISED",
  };
  return {
    targets: [{
      targetId: id,
      targetType: "credit_note",
      humanRef: ref,
      currentState: { status, total: cn.Total, reference: cn.Reference },
      proposedState: { action: "approve_credit_note", creditNoteId: id, resultingStatus: "AUTHORISED", stateFingerprint: { status, total: cn.Total } },
      amount: Number(cn.Total ?? 0),
      currencyCode: cn.CurrencyCode ? String(cn.CurrencyCode) : null,
      validation: "valid",
    }],
    summary: `Approve sales credit note ${ref} for ${formatMoney(Number(cn.Total ?? 0))}.`,
    financialImpact: { currencyCode: cn.CurrencyCode ? String(cn.CurrencyCode) : null, totalAmount: Number(cn.Total ?? 0), direction: "credit", itemCount: 1 },
    review,
  };
}

export async function planXeroVoidDocument(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  actor: string;
  invoiceId?: string;
  creditNoteId?: string;
  documentKind?: "invoice" | "bill" | "credit_note";
  reason?: string;
}): Promise<{ targets: ActionTarget[]; summary: string; financialImpact: FinancialImpact; review: Record<string, unknown> }> {
  const tok = await token(input.env, input.companyId, input.instanceId, input.actor);
  if (!tok.ok) throw new Error(tok.body.error);

  if (input.creditNoteId || input.documentKind === "credit_note") {
    const cnId = input.creditNoteId ?? "";
    const body = await xeroGetJson<{ CreditNotes?: Array<Record<string, unknown>> }>(xeroConfig(tok), `/CreditNotes/${cnId}`);
    const cn = body.CreditNotes?.[0];
    if (!cn) {
      return { targets: [invalidTarget(cnId, cnId, "credit_note", "not_found", "Credit note not found.")], summary: "Void plan failed.", financialImpact: { currencyCode: null, totalAmount: null, direction: "neutral", itemCount: 0 }, review: {} };
    }
    const ref = String(cn.CreditNoteNumber ?? cnId);
    return {
      targets: [{
        targetId: cnId,
        targetType: "credit_note",
        humanRef: ref,
        currentState: { status: cn.Status, total: cn.Total },
        proposedState: { action: "void_credit_note", creditNoteId: cnId, resultingStatus: "VOIDED", reason: input.reason ?? null },
        amount: Number(cn.Total ?? 0),
        validation: "valid",
      }],
      summary: `VOID sales credit note ${ref} — this cannot be undone without a reversing document.`,
      financialImpact: { currencyCode: cn.CurrencyCode ? String(cn.CurrencyCode) : null, totalAmount: Number(cn.Total ?? 0), direction: "neutral", itemCount: 1 },
      review: { documentKind: "SALES CREDIT NOTE", warning: "YOU ARE ABOUT TO VOID this credit note.", currentStatus: cn.Status, resultingStatus: "VOIDED", reason: input.reason ?? null },
    };
  }

  const invoice = await fetchInvoice(tok, { invoiceId: input.invoiceId });
  const id = String(invoice?.InvoiceID ?? input.invoiceId ?? "unknown");
  const ref = String(invoice?.InvoiceNumber ?? id);
  if (!invoice) {
    return { targets: [invalidTarget(id, ref, "invoice", "not_found", "Document not found.")], summary: "Void plan failed.", financialImpact: { currencyCode: null, totalAmount: null, direction: "neutral", itemCount: 0 }, review: {} };
  }
  const kind = String(invoice.Type ?? "") === "ACCPAY" ? "SUPPLIER BILL" : "SALES INVOICE";
  return {
    targets: [{
      targetId: id,
      targetType: String(invoice.Type ?? "") === "ACCPAY" ? "draft_bill" : "invoice",
      humanRef: ref,
      currentState: { ...stateFingerprint(invoice), ...invoiceReview(invoice) },
      proposedState: { action: "void_document", invoiceId: id, type: invoice.Type, resultingStatus: "VOIDED", reason: input.reason ?? null },
      amount: Number(invoice.Total ?? 0),
      currencyCode: invoice.CurrencyCode ?? null,
      validation: "valid",
    }],
    summary: `VOID ${kind} ${ref} — this cannot be undone without a reversing document.`,
    financialImpact: { currencyCode: invoice.CurrencyCode ?? null, totalAmount: Number(invoice.Total ?? 0), direction: "neutral", itemCount: 1 },
    review: { documentKind: kind, warning: `YOU ARE ABOUT TO VOID ${kind} ${ref}.`, currentStatus: invoice.Status, resultingStatus: "VOIDED", reason: input.reason ?? null },
  };
}

export async function planXeroCreditNoteAllocation(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  actor: string;
  creditNoteId: string;
  invoiceId: string;
  amount: number;
}): Promise<{ targets: ActionTarget[]; summary: string; financialImpact: FinancialImpact; review: Record<string, unknown> }> {
  const tok = await token(input.env, input.companyId, input.instanceId, input.actor);
  if (!tok.ok) throw new Error(tok.body.error);

  const cnBody = await xeroGetJson<{ CreditNotes?: Array<Record<string, unknown>> }>(
    xeroConfig(tok),
    `/CreditNotes/${input.creditNoteId}`,
  );
  const cn = cnBody.CreditNotes?.[0];
  const invoice = await fetchInvoice(tok, { invoiceId: input.invoiceId });

  if (!cn) {
    return {
      targets: [invalidTarget(input.creditNoteId, input.creditNoteId, "credit_note", "not_found", "Credit note not found.")],
      summary: "Credit note allocation plan failed.",
      financialImpact: { currencyCode: null, totalAmount: null, direction: "credit", itemCount: 0 },
      review: {},
    };
  }
  if (!invoice) {
    return {
      targets: [invalidTarget(input.invoiceId, input.invoiceId, "invoice", "not_found", "Target invoice not found.")],
      summary: "Credit note allocation plan failed.",
      financialImpact: { currencyCode: null, totalAmount: null, direction: "credit", itemCount: 0 },
      review: {},
    };
  }

  const cnContact = (cn.Contact as { ContactID?: string })?.ContactID;
  const invContact = invoice.Contact?.ContactID;
  const cnRemaining = Number(cn.RemainingCredit ?? cn.Total ?? 0);
  const invDue = Number(invoice.AmountDue ?? 0);
  const cnCurrency = String(cn.CurrencyCode ?? "GBP");
  const invCurrency = String(invoice.CurrencyCode ?? "GBP");
  const cnStatus = String(cn.Status ?? "");
  const invStatus = String(invoice.Status ?? "");

  let validation: ActionTarget["validation"] = "valid";
  let validationDetail: string | null = null;

  if (cnContact && invContact && cnContact !== invContact) {
    validation = "invalid";
    validationDetail = "Contact mismatch between credit note and invoice.";
  } else if (cnCurrency !== invCurrency) {
    validation = "invalid";
    validationDetail = "Currency mismatch.";
  } else if (String(cn.Type ?? "") !== "ACCRECCREDIT") {
    validation = "invalid";
    validationDetail = "Only sales credit notes (ACCRECCREDIT) can be allocated.";
  } else if (String(invoice.Type ?? "") !== "ACCREC") {
    validation = "invalid";
    validationDetail = "Target must be a sales invoice (ACCREC).";
  } else if (input.amount <= 0) {
    validation = "invalid";
    validationDetail = "Allocation amount must be positive.";
  } else if (input.amount > cnRemaining) {
    validation = "invalid";
    validationDetail = `Over-allocation: credit note has ${cnRemaining} remaining.`;
  } else if (input.amount > invDue) {
    validation = "invalid";
    validationDetail = `Over-allocation: invoice has ${invDue} due.`;
  } else if (cnStatus === "VOIDED" || invStatus === "VOIDED") {
    validation = "invalid";
    validationDetail = "Cannot allocate to or from voided documents.";
  } else if (invStatus === "PAID") {
    validation = "invalid";
    validationDetail = "Target invoice is already paid.";
  } else if (!["AUTHORISED", "SUBMITTED"].includes(cnStatus)) {
    validation = "invalid";
    validationDetail = `Credit note status ${cnStatus} is not eligible for allocation.`;
  }

  const ref = String(cn.CreditNoteNumber ?? input.creditNoteId);
  const invRef = String(invoice.InvoiceNumber ?? input.invoiceId);

  return {
    targets: [{
      targetId: input.creditNoteId,
      targetType: "credit_note_allocation",
      humanRef: ref,
      currentState: {
        creditNoteRemaining: cnRemaining,
        invoiceAmountDue: invDue,
        contactId: cnContact,
      },
      proposedState: {
        action: "allocate_credit_note",
        creditNoteId: input.creditNoteId,
        invoiceId: input.invoiceId,
        allocateAmount: input.amount,
      },
      amount: input.amount,
      currencyCode: cnCurrency,
      validation,
      validationDetail,
    }],
    summary: validation === "valid"
      ? `Allocate ${formatMoney(input.amount)} from credit note ${ref} to invoice ${invRef}.`
      : `Credit note allocation invalid: ${validationDetail}`,
    financialImpact: {
      currencyCode: cnCurrency,
      totalAmount: input.amount,
      direction: "credit",
      itemCount: 1,
    },
    review: {
      creditNoteNumber: ref,
      invoiceNumber: invRef,
      amount: input.amount,
      remainingCredit: cnRemaining,
      invoiceAmountDue: invDue,
      validationDetail,
    },
  };
}
