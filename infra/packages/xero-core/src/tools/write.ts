/**
 * Write tool contracts — architecture-ready, production execution gated by INFRA.
 * Company MCP should call these only after INFRA permission + approval checks pass.
 */

import type { XeroClient } from "../client";

export type DraftInvoiceLineItem = {
  description: string;
  quantity: number;
  unitAmount: number;
  accountCode?: string;
  taxType?: string;
};

export type DraftInvoiceInput = {
  contactId: string;
  lineItems: DraftInvoiceLineItem[];
  reference?: string;
  date?: string;
  dueDate?: string;
};

export async function createDraftInvoice(client: XeroClient, input: DraftInvoiceInput) {
  const body = await client.post<{ Invoices?: unknown[] }>("/Invoices", {
    Invoices: [
      {
        Type: "ACCREC",
        Contact: { ContactID: input.contactId },
        LineItems: input.lineItems.map((row) => ({
          Description: row.description,
          Quantity: row.quantity,
          UnitAmount: row.unitAmount,
          AccountCode: row.accountCode,
          TaxType: row.taxType,
        })),
        Reference: input.reference,
        Date: input.date,
        DueDate: input.dueDate,
        Status: "DRAFT",
      },
    ],
  });
  return { invoice: body.Invoices?.[0] ?? null };
}

export async function updateDraftInvoice(
  client: XeroClient,
  input: {
    invoiceId: string;
    patch: { reference?: string; lineItems?: DraftInvoiceInput["lineItems"] };
  },
) {
  const body = await client.post<{ Invoices?: unknown[] }>("/Invoices", {
    Invoices: [
      {
        InvoiceID: input.invoiceId,
        Reference: input.patch.reference,
        LineItems: input.patch.lineItems,
        Status: "DRAFT",
      },
    ],
  });
  return { invoice: body.Invoices?.[0] ?? null };
}

export async function createOrUpdateContact(
  client: XeroClient,
  input: {
    contactId?: string;
    name: string;
    email?: string;
  },
) {
  const payload: Record<string, unknown> = {
    Name: input.name,
    EmailAddress: input.email,
  };
  if (input.contactId) payload.ContactID = input.contactId;
  const body = await client.post<{ Contacts?: unknown[] }>("/Contacts", {
    Contacts: [payload],
  });
  return { contact: body.Contacts?.[0] ?? null };
}

export async function createCreditNote(
  client: XeroClient,
  input: {
    contactId: string;
    lineItems: Array<{ description: string; quantity: number; unitAmount: number }>;
    reference?: string;
  },
) {
  const body = await client.post<{ CreditNotes?: unknown[] }>("/CreditNotes", {
    CreditNotes: [
      {
        Type: "ACCRECCREDIT",
        Contact: { ContactID: input.contactId },
        LineItems: input.lineItems,
        Reference: input.reference,
        Status: "AUTHORISED",
      },
    ],
  });
  return { creditNote: body.CreditNotes?.[0] ?? null };
}

export async function allocateCreditNote(
  client: XeroClient,
  input: { creditNoteId: string; allocations: Array<{ invoiceId: string; amount: number }> },
) {
  const results = [];
  for (const allocation of input.allocations) {
    const body = await client.put<{ Allocations?: unknown[] }>(
      `/CreditNotes/${input.creditNoteId}/Allocations`,
      {
        Allocations: [
          {
            Invoice: { InvoiceID: allocation.invoiceId },
            Amount: allocation.amount,
          },
        ],
      },
    );
    results.push(body.Allocations?.[0] ?? null);
  }
  return { allocations: results };
}

export async function allocatePayment(
  client: XeroClient,
  input: { paymentId: string; allocations: Array<{ invoiceId: string; amount: number }> },
) {
  const body = await client.put<{ Payments?: unknown[] }>(`/Payments/${input.paymentId}`, {
    Payments: [
      {
        PaymentID: input.paymentId,
        Allocations: input.allocations.map((row) => ({
          Invoice: { InvoiceID: row.invoiceId },
          Amount: row.amount,
        })),
      },
    ],
  });
  return { payment: body.Payments?.[0] ?? null };
}
