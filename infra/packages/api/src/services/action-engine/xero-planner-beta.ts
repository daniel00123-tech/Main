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
