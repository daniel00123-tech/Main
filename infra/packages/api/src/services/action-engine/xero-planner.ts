import {
  ACTION_PLAN_MAX_BATCH_ITEMS,
  type ActionTarget,
  type FinancialImpact,
  type RemittanceAllocationCandidate,
  XERO_DATA_BOUNDS,
} from "@infra/shared";
import type { Env } from "../../env";
import { getValidXeroAccessToken } from "../xero";
import { xeroGetJson } from "@infra/xero-core";
import { XERO_AUTH } from "@infra/shared";
import { listConnectorInstances, getConnectorInstance } from "../control-plane";
import { isSalesTransactionType } from "@infra/xero-core";
import { fingerprintTargets } from "./action-engine";

type XeroInvoiceRow = {
  InvoiceID?: string;
  InvoiceNumber?: string;
  Type?: string;
  Status?: string;
  Total?: number;
  AmountDue?: number;
  AmountPaid?: number;
  CurrencyCode?: string;
  Contact?: { ContactID?: string; Name?: string };
  LineItems?: Array<{ Description?: string; Quantity?: number; UnitAmount?: number; AccountCode?: string }>;
};

async function resolveXeroToken(env: Env, companyId: string, instanceId: string, actor: string) {
  return getValidXeroAccessToken({
    env,
    companyId,
    instanceId,
    actor,
    reason: "mcp_resolve",
  });
}

async function fetchInvoice(
  token: { accessToken: string; tenantId: string },
  input: { invoiceId?: string; invoiceNumber?: string },
): Promise<XeroInvoiceRow | null> {
  if (input.invoiceId) {
    const body = await xeroGetJson<{ Invoices?: XeroInvoiceRow[] }>(
      { accessToken: token.accessToken, tenantId: token.tenantId, apiBaseUrl: XERO_AUTH.apiBaseUrl },
      `/Invoices/${input.invoiceId}`,
    );
    return body.Invoices?.[0] ?? null;
  }
  if (input.invoiceNumber) {
    const body = await xeroGetJson<{ Invoices?: XeroInvoiceRow[] }>(
      { accessToken: token.accessToken, tenantId: token.tenantId, apiBaseUrl: XERO_AUTH.apiBaseUrl },
      "/Invoices",
      { where: `InvoiceNumber=="${input.invoiceNumber.replace(/"/g, "")}"` },
    );
    return body.Invoices?.[0] ?? null;
  }
  return null;
}

function validateSalesInvoice(invoice: XeroInvoiceRow | null): ActionTarget {
  if (!invoice) {
    return {
      targetId: "unknown",
      targetType: "invoice",
      humanRef: "unknown",
      currentState: {},
      proposedState: {},
      validation: "not_found",
      validationDetail: "Invoice not found in Xero.",
    };
  }
  const type = String(invoice.Type ?? "");
  const status = String(invoice.Status ?? "");
  if (!isSalesTransactionType(type)) {
    return {
      targetId: String(invoice.InvoiceID ?? ""),
      targetType: "invoice",
      humanRef: String(invoice.InvoiceNumber ?? invoice.InvoiceID ?? ""),
      currentState: {
        type,
        status,
        total: invoice.Total ?? null,
        contactName: invoice.Contact?.Name ?? null,
      },
      proposedState: {},
      amount: Number(invoice.Total ?? 0),
      currencyCode: invoice.CurrencyCode ?? null,
      validation: "wrong_type",
      validationDetail: `${type} is not an Accounts Receivable sales invoice.`,
    };
  }
  if (status === "VOIDED" || status === "DELETED" || status === "DRAFT") {
    return {
      targetId: String(invoice.InvoiceID ?? ""),
      targetType: "invoice",
      humanRef: String(invoice.InvoiceNumber ?? invoice.InvoiceID ?? ""),
      currentState: { type, status, total: invoice.Total ?? null },
      proposedState: {},
      validation: "wrong_status",
      validationDetail: `Invoice status ${status} cannot be credited.`,
    };
  }
  const outstanding = Number(invoice.AmountDue ?? invoice.Total ?? 0);
  if (outstanding <= 0) {
    return {
      targetId: String(invoice.InvoiceID ?? ""),
      targetType: "invoice",
      humanRef: String(invoice.InvoiceNumber ?? invoice.InvoiceID ?? ""),
      currentState: { type, status, outstanding },
      proposedState: {},
      validation: "zero_outstanding",
      validationDetail: "Invoice has no outstanding balance to credit.",
    };
  }
  return {
    targetId: String(invoice.InvoiceID ?? ""),
    targetType: "invoice",
    humanRef: String(invoice.InvoiceNumber ?? invoice.InvoiceID ?? ""),
    currentState: {
      type,
      status,
      total: invoice.Total ?? null,
      amountDue: invoice.AmountDue ?? null,
      contactId: invoice.Contact?.ContactID ?? null,
      contactName: invoice.Contact?.Name ?? null,
      currencyCode: invoice.CurrencyCode ?? null,
    },
    proposedState: {
      action: "create_sales_credit_note",
      creditAmount: outstanding,
      allocateToInvoiceId: invoice.InvoiceID ?? null,
    },
    amount: outstanding,
    currencyCode: invoice.CurrencyCode ?? null,
    validation: "valid",
  };
}

export async function planXeroCreditInvoices(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  actor: string;
  invoiceNumbers: string[];
}): Promise<{
  targets: ActionTarget[];
  summary: string;
  financialImpact: FinancialImpact;
  allValid: boolean;
}> {
  const numbers = [...new Set(input.invoiceNumbers.map((n) => n.trim()).filter(Boolean))].slice(
    0,
    Math.min(ACTION_PLAN_MAX_BATCH_ITEMS, XERO_DATA_BOUNDS.maxBatchWriteItems),
  );
  const token = await resolveXeroToken(input.env, input.companyId, input.instanceId, input.actor);
  if (!token.ok) throw new Error(token.body.error);

  const xeroToken = { accessToken: token.accessToken, tenantId: token.tenantId };
  const targets: ActionTarget[] = [];
  for (const invoiceNumber of numbers) {
    const invoice = await fetchInvoice(xeroToken, { invoiceNumber });
    targets.push(validateSalesInvoice(invoice));
  }

  const valid = targets.filter((t) => t.validation === "valid");
  const currencyCode = valid[0]?.currencyCode ?? targets[0]?.currencyCode ?? null;
  const totalAmount = valid.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
  const allValid = targets.length > 0 && targets.every((t) => t.validation === "valid");

  return {
    targets,
    summary: allValid
      ? `Credit ${valid.length} sales invoice(s) totalling ${totalAmount}${currencyCode ? ` ${currencyCode}` : ""}.`
      : `Credit plan for ${targets.length} invoice(s) — ${targets.filter((t) => t.validation !== "valid").length} failed validation.`,
    financialImpact: {
      currencyCode,
      totalAmount: valid.length ? totalAmount : null,
      direction: "credit",
      itemCount: targets.length,
    },
    allValid,
  };
}

export async function planXeroDraftInvoice(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  actor: string;
  contactId: string;
  lineItems: Array<{ description: string; quantity: number; unitAmount: number; accountCode?: string }>;
  reference?: string;
  date?: string;
}): Promise<{ targets: ActionTarget[]; summary: string; financialImpact: FinancialImpact }> {
  const token = await resolveXeroToken(input.env, input.companyId, input.instanceId, input.actor);
  if (!token.ok) throw new Error(token.body.error);
  const contactBody = await xeroGetJson<{ Contacts?: Array<{ ContactID?: string; Name?: string }> }>(
    { accessToken: token.accessToken, tenantId: token.tenantId, apiBaseUrl: XERO_AUTH.apiBaseUrl },
    `/Contacts/${input.contactId}`,
  );
  const contact = contactBody.Contacts?.[0];
  if (!contact) {
    return {
      targets: [
        {
          targetId: input.contactId,
          targetType: "contact",
          humanRef: input.contactId,
          currentState: {},
          proposedState: {},
          validation: "not_found",
          validationDetail: "Contact not found in Xero.",
        },
      ],
      summary: "Draft invoice plan failed — contact not found.",
      financialImpact: { currencyCode: null, totalAmount: null, direction: "debit", itemCount: 0 },
    };
  }

  const totalAmount = input.lineItems.reduce(
    (sum, row) => sum + Number(row.quantity) * Number(row.unitAmount),
    0,
  );
  const target: ActionTarget = {
    targetId: input.contactId,
    targetType: "draft_invoice",
    humanRef: contact.Name ?? input.contactId,
    currentState: { contactId: input.contactId, contactName: contact.Name ?? null },
    proposedState: {
      action: "create_draft_invoice",
      type: "ACCREC",
      status: "DRAFT",
      contactId: input.contactId,
      lineItems: input.lineItems,
      reference: input.reference ?? null,
      date: input.date ?? null,
    },
    amount: totalAmount,
    validation: "valid",
  };

  return {
    targets: [target],
    summary: `Create draft sales invoice for ${contact.Name ?? "contact"} totalling ${totalAmount}.`,
    financialImpact: {
      currencyCode: null,
      totalAmount,
      direction: "debit",
      itemCount: 1,
    },
  };
}

export async function planXeroRemittanceAllocation(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  actor: string;
  paymentAmount: number;
  currencyCode: string;
  invoiceHints: Array<{ invoiceNumber?: string; amount?: number }>;
}): Promise<{
  targets: ActionTarget[];
  candidates: RemittanceAllocationCandidate[];
  summary: string;
  financialImpact: FinancialImpact;
  confidence: "exact" | "high" | "ambiguous" | "no_match";
}> {
  const token = await resolveXeroToken(input.env, input.companyId, input.instanceId, input.actor);
  if (!token.ok) throw new Error(token.body.error);
  const xeroToken = { accessToken: token.accessToken, tenantId: token.tenantId };

  const candidates: RemittanceAllocationCandidate[] = [];
  for (const hint of input.invoiceHints.slice(0, ACTION_PLAN_MAX_BATCH_ITEMS)) {
    if (!hint.invoiceNumber) continue;
    const invoice = await fetchInvoice(xeroToken, { invoiceNumber: hint.invoiceNumber });
    if (!invoice || !isSalesTransactionType(String(invoice.Type ?? ""))) continue;
    const amountDue = Number(invoice.AmountDue ?? 0);
    candidates.push({
      invoiceId: String(invoice.InvoiceID ?? ""),
      invoiceNumber: String(invoice.InvoiceNumber ?? hint.invoiceNumber),
      contactName: invoice.Contact?.Name ?? "Unknown",
      amountDue,
      currencyCode: String(invoice.CurrencyCode ?? input.currencyCode),
      confidence:
        hint.amount != null && Math.abs(hint.amount - amountDue) < 0.01 ? "exact" : "high",
      reason:
        hint.amount != null && Math.abs(hint.amount - amountDue) < 0.01
          ? "Remittance amount matches invoice outstanding balance."
          : "Invoice matched by number; verify amount before execution.",
    });
  }

  const candidateTotal = candidates.reduce((sum, row) => sum + row.amountDue, 0);
  let confidence: "exact" | "high" | "ambiguous" | "no_match" = "no_match";
  if (candidates.length === 0) confidence = "no_match";
  else if (Math.abs(candidateTotal - input.paymentAmount) < 0.01 && candidates.every((c) => c.confidence === "exact")) {
    confidence = "exact";
  } else if (candidates.length === 1) confidence = "high";
  else confidence = "ambiguous";

  const targets: ActionTarget[] = candidates.map((candidate) => ({
    targetId: candidate.invoiceId,
    targetType: "invoice_allocation",
    humanRef: candidate.invoiceNumber,
    currentState: {
      amountDue: candidate.amountDue,
      contactName: candidate.contactName,
      currencyCode: candidate.currencyCode,
    },
    proposedState: {
      action: "allocate_payment",
      allocateAmount: candidate.amountDue,
    },
    amount: candidate.amountDue,
    currencyCode: candidate.currencyCode,
    validation: confidence === "ambiguous" ? "ambiguous" : "valid",
    validationDetail:
      confidence === "ambiguous"
        ? "Multiple allocation combinations possible — user decision required."
        : null,
  }));

  return {
    targets,
    candidates,
    summary:
      confidence === "no_match"
        ? "No matching sales invoices found for remittance allocation."
        : confidence === "ambiguous"
          ? "Multiple possible remittance allocations found — confirmation required."
          : `Allocate ${input.paymentAmount} ${input.currencyCode} across ${targets.length} invoice(s).`,
    financialImpact: {
      currencyCode: input.currencyCode,
      totalAmount: input.paymentAmount,
      direction: "neutral",
      itemCount: targets.length,
    },
    confidence,
  };
}

export async function resolveConnectedXeroInstance(env: Env, companyId: string) {
  const instances = await listConnectorInstances(env.DB, companyId);
  const instance =
    instances.find(
      (row) =>
        row.connectorDefinitionId === "conn_xero" &&
        row.authStatus === "connected" &&
        Boolean(row.externalAccountId),
    ) ?? null;
  if (!instance) return null;
  const fresh = await getConnectorInstance(env.DB, instance.id);
  if (!fresh || fresh.companyId !== companyId) return null;
  return fresh;
}

/** Re-fetch live Xero state for plan targets and return updated targets + fingerprint. */
export async function revalidateXeroPlanTargets(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  actor: string;
  requestedAction: string;
  targets: ActionTarget[];
}): Promise<{ targets: ActionTarget[]; fingerprint: string }> {
  const token = await resolveXeroToken(input.env, input.companyId, input.instanceId, input.actor);
  if (!token.ok) throw new Error(token.body.error);
  const xeroToken = { accessToken: token.accessToken, tenantId: token.tenantId };

  if (input.requestedAction === "xero.credit_notes.create") {
    const targets: ActionTarget[] = [];
    for (const target of input.targets) {
      const invoice = await fetchInvoice(xeroToken, { invoiceId: target.targetId });
      targets.push(validateSalesInvoice(invoice));
    }
    return { targets, fingerprint: await fingerprintTargets(targets) };
  }

  if (input.requestedAction === "xero.invoices.create") {
    const contactId = input.targets[0]?.targetId ?? "";
    const contactBody = await xeroGetJson<{ Contacts?: Array<{ ContactID?: string; Name?: string }> }>(
      { accessToken: token.accessToken, tenantId: token.tenantId, apiBaseUrl: XERO_AUTH.apiBaseUrl },
      `/Contacts/${contactId}`,
    );
    const contact = contactBody.Contacts?.[0];
    const proposed = input.targets[0]?.proposedState ?? {};
    const target: ActionTarget = contact
      ? {
          targetId: contactId,
          targetType: "draft_invoice",
          humanRef: contact.Name ?? contactId,
          currentState: { contactId, contactName: contact.Name ?? null },
          proposedState: proposed,
          amount: input.targets[0]?.amount ?? null,
          validation: "valid",
        }
      : {
          targetId: contactId,
          targetType: "contact",
          humanRef: contactId,
          currentState: {},
          proposedState: {},
          validation: "not_found",
          validationDetail: "Contact not found in Xero.",
        };
    const targets = [target];
    return { targets, fingerprint: await fingerprintTargets(targets) };
  }

  if (input.requestedAction === "xero.payments.allocate") {
    const targets: ActionTarget[] = [];
    for (const target of input.targets) {
      const invoice = await fetchInvoice(xeroToken, { invoiceId: target.targetId });
      if (!invoice || !isSalesTransactionType(String(invoice.Type ?? ""))) {
        targets.push({
          ...target,
          validation: "not_found",
          validationDetail: "Invoice not found or not ACCREC.",
        });
        continue;
      }
      const amountDue = Number(invoice.AmountDue ?? 0);
      targets.push({
        ...target,
        currentState: {
          amountDue,
          contactName: invoice.Contact?.Name ?? null,
          currencyCode: invoice.CurrencyCode ?? null,
        },
        amount: amountDue,
        validation: amountDue <= 0 ? "zero_outstanding" : target.validation,
      });
    }
    return { targets, fingerprint: await fingerprintTargets(targets) };
  }

  return { targets: input.targets, fingerprint: await fingerprintTargets(input.targets) };
}
