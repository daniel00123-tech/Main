import { XERO_AUTH } from "@infra/shared";
import type { ActionTarget } from "@infra/shared";
import { xeroReadTools } from "@infra/xero-core";
import { XeroClient } from "@infra/xero-core";
import type { Env } from "../../env";
import { getValidXeroAccessToken } from "../xero";

import {
  draftInvoiceExpectedFromProposed,
} from "./draft-invoice-plan";

export type DraftInvoiceVerificationExpected = {
  contactId: string;
  type: "ACCREC";
  status: "DRAFT";
  total: number;
  reference?: string | null;
  lineItemDescription?: string | null;
  dueDate?: string | null;
  invoiceDate?: string | null;
  taxType?: string | null;
  accountCode?: string | null;
};

export type VerificationResult =
  | { ok: true; invoice: Record<string, unknown> }
  | { ok: false; code: string; message: string; invoice?: Record<string, unknown> | null };

export async function verifyCreatedDraftInvoice(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  actor: string;
  invoiceId: string;
  expected: DraftInvoiceVerificationExpected;
}): Promise<VerificationResult> {
  const token = await getValidXeroAccessToken({
    env: input.env,
    companyId: input.companyId,
    instanceId: input.instanceId,
    actor: input.actor,
    reason: "action_verify",
  });
  if (!token.ok) {
    return { ok: false, code: "XERO_AUTH_FAILED", message: token.body.error };
  }

  const client = new XeroClient({
    accessToken: token.accessToken,
    tenantId: token.tenantId,
    apiBaseUrl: XERO_AUTH.apiBaseUrl,
  });

  const fetched = await xeroReadTools.getInvoice(client, { invoiceId: input.invoiceId });
  const invoice = fetched.invoice as Record<string, unknown> | null;
  if (!invoice) {
    return { ok: false, code: "VERIFICATION_NOT_FOUND", message: "Created invoice not found in Xero." };
  }

  const type = String(invoice.Type ?? "");
  const status = String(invoice.Status ?? "");
  const contact = invoice.Contact as Record<string, unknown> | undefined;
  const contactId = contact?.ContactID ? String(contact.ContactID) : "";
  const total = Number(invoice.Total ?? 0);
  const reference = invoice.Reference ? String(invoice.Reference) : null;

  if (type !== input.expected.type) {
    return {
      ok: false,
      code: "VERIFICATION_WRONG_TYPE",
      message: `Expected ${input.expected.type}, got ${type}.`,
      invoice,
    };
  }
  if (status !== input.expected.status) {
    return {
      ok: false,
      code: "VERIFICATION_WRONG_STATUS",
      message: `Expected ${input.expected.status}, got ${status}.`,
      invoice,
    };
  }
  if (contactId !== input.expected.contactId) {
    return {
      ok: false,
      code: "VERIFICATION_WRONG_CONTACT",
      message: "Invoice contact does not match plan.",
      invoice,
    };
  }
  if (Math.abs(total - input.expected.total) > 0.01) {
    return {
      ok: false,
      code: "VERIFICATION_WRONG_AMOUNT",
      message: `Expected total ${input.expected.total}, got ${total}.`,
      invoice,
    };
  }
  if (input.expected.reference && reference !== input.expected.reference) {
    return {
      ok: false,
      code: "VERIFICATION_WRONG_REFERENCE",
      message: "Invoice reference does not match plan.",
      invoice,
    };
  }

  if (input.expected.lineItemDescription) {
    const lines = Array.isArray(invoice.LineItems) ? invoice.LineItems : [];
    const match = lines.some(
      (line) =>
        String((line as Record<string, unknown>).Description ?? "") ===
        input.expected.lineItemDescription,
    );
    if (!match) {
      return {
        ok: false,
        code: "VERIFICATION_LINE_ITEMS",
        message: "Line item description not found on created invoice.",
        invoice,
      };
    }
  }

  if (input.expected.dueDate) {
    const due = invoice.DueDate ? String(invoice.DueDate).slice(0, 10) : null;
    if (due !== input.expected.dueDate) {
      return {
        ok: false,
        code: "VERIFICATION_WRONG_DUE_DATE",
        message: `Expected due date ${input.expected.dueDate}, got ${due ?? "null"}.`,
        invoice,
      };
    }
  }

  if (input.expected.taxType) {
    const lines = Array.isArray(invoice.LineItems) ? invoice.LineItems : [];
    const lineTax = lines[0]
      ? String((lines[0] as Record<string, unknown>).TaxType ?? "")
      : "";
    if (lineTax && lineTax !== input.expected.taxType) {
      return {
        ok: false,
        code: "VERIFICATION_WRONG_TAX_TYPE",
        message: `Expected tax type ${input.expected.taxType}, got ${lineTax}.`,
        invoice,
      };
    }
  }

  return { ok: true, invoice };
}

export function draftInvoiceExpectedFromTarget(target: ActionTarget): DraftInvoiceVerificationExpected | null {
  return draftInvoiceExpectedFromProposed(target);
}

export function extractInvoiceIdFromMcpResult(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const payload = result as Record<string, unknown>;
  const invoice = payload.invoice as Record<string, unknown> | undefined;
  if (invoice?.InvoiceID) return String(invoice.InvoiceID);
  return null;
}

export function extractInvoiceNumberFromMcpResult(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const payload = result as Record<string, unknown>;
  const invoice = payload.invoice as Record<string, unknown> | undefined;
  if (invoice?.InvoiceNumber) return String(invoice.InvoiceNumber);
  return null;
}
