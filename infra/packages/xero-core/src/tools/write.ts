/**
 * Write tool contracts — architecture-ready, production execution gated by INFRA.
 * Company MCP should call these only after INFRA permission + approval checks pass.
 */

import type { XeroClient } from "../client";
import { xeroPostJson, type XeroFetchConfig } from "../fetch-json";
import { withXeroRetry } from "../retry";

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

export async function createDraftInvoiceWithFetch(
  config: XeroFetchConfig,
  input: DraftInvoiceInput,
) {
  const body = await xeroPostJson<{ Invoices?: unknown[] }>(config, "/Invoices", {
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

// --- Fetch-based write operations for Action Engine / Company MCP ---

type InvoiceRow = Record<string, unknown>;

function invoiceFromBody(body: { Invoices?: InvoiceRow[] }): InvoiceRow | null {
  return body.Invoices?.[0] ?? null;
}

function creditNoteFromBody(body: { CreditNotes?: InvoiceRow[] }): InvoiceRow | null {
  return body.CreditNotes?.[0] ?? null;
}

function contactFromBody(body: { Contacts?: InvoiceRow[] }): InvoiceRow | null {
  return body.Contacts?.[0] ?? null;
}

export async function approveInvoiceWithFetch(config: XeroFetchConfig, input: { invoiceId: string }) {
  return withXeroRetry(async () => {
    const body = await xeroPostJson<{ Invoices?: InvoiceRow[] }>(config, "/Invoices", {
      Invoices: [{ InvoiceID: input.invoiceId, Status: "AUTHORISED" }],
    });
    return { invoice: invoiceFromBody(body) };
  });
}

export async function sendInvoiceWithFetch(
  config: XeroFetchConfig,
  input: { invoiceId: string; emailAddress?: string },
) {
  return withXeroRetry(async () => {
    const payload: Record<string, unknown> = {};
    if (input.emailAddress) payload.To = input.emailAddress;
    const body = await xeroPostJson<{ Invoices?: InvoiceRow[] }>(
      config,
      `/Invoices/${input.invoiceId}/Email`,
      payload,
    );
    return { invoice: invoiceFromBody(body), sent: true };
  });
}

export async function updateDraftInvoiceWithFetch(
  config: XeroFetchConfig,
  input: {
    invoiceId: string;
    type: "ACCREC" | "ACCPAY";
    patch: {
      reference?: string;
      date?: string;
      dueDate?: string;
      contactId?: string;
      lineItems?: DraftInvoiceLineItem[];
    };
  },
) {
  return withXeroRetry(async () => {
    const row: Record<string, unknown> = {
      InvoiceID: input.invoiceId,
      Type: input.type,
      Status: "DRAFT",
    };
    if (input.patch.reference != null) row.Reference = input.patch.reference;
    if (input.patch.date != null) row.Date = input.patch.date;
    if (input.patch.dueDate != null) row.DueDate = input.patch.dueDate;
    if (input.patch.contactId != null) row.Contact = { ContactID: input.patch.contactId };
    if (input.patch.lineItems != null) {
      row.LineItems = input.patch.lineItems.map((line) => ({
        Description: line.description,
        Quantity: line.quantity,
        UnitAmount: line.unitAmount,
        AccountCode: line.accountCode,
        TaxType: line.taxType,
      }));
    }
    const body = await xeroPostJson<{ Invoices?: InvoiceRow[] }>(config, "/Invoices", {
      Invoices: [row],
    });
    return { invoice: invoiceFromBody(body) };
  });
}

export async function createDraftBillWithFetch(
  config: XeroFetchConfig,
  input: DraftInvoiceInput,
) {
  return withXeroRetry(async () => {
    const body = await xeroPostJson<{ Invoices?: InvoiceRow[] }>(config, "/Invoices", {
      Invoices: [
        {
          Type: "ACCPAY",
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
    return { bill: invoiceFromBody(body) };
  });
}

export async function approveBillWithFetch(config: XeroFetchConfig, input: { invoiceId: string }) {
  return withXeroRetry(async () => {
    const body = await xeroPostJson<{ Invoices?: InvoiceRow[] }>(config, "/Invoices", {
      Invoices: [{ InvoiceID: input.invoiceId, Type: "ACCPAY", Status: "AUTHORISED" }],
    });
    return { bill: invoiceFromBody(body) };
  });
}

export async function createDraftCreditNoteWithFetch(
  config: XeroFetchConfig,
  input: {
    contactId: string;
    lineItems: DraftInvoiceLineItem[];
    reference?: string;
    date?: string;
  },
) {
  return withXeroRetry(async () => {
    const body = await xeroPostJson<{ CreditNotes?: InvoiceRow[] }>(config, "/CreditNotes", {
      CreditNotes: [
        {
          Type: "ACCRECCREDIT",
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
          Status: "DRAFT",
        },
      ],
    });
    return { creditNote: creditNoteFromBody(body) };
  });
}

export async function approveCreditNoteWithFetch(
  config: XeroFetchConfig,
  input: { creditNoteId: string },
) {
  return withXeroRetry(async () => {
    const body = await xeroPostJson<{ CreditNotes?: InvoiceRow[] }>(config, "/CreditNotes", {
      CreditNotes: [{ CreditNoteID: input.creditNoteId, Status: "AUTHORISED" }],
    });
    return { creditNote: creditNoteFromBody(body) };
  });
}

export async function allocateCreditNoteWithFetch(
  config: XeroFetchConfig,
  input: { creditNoteId: string; invoiceId: string; amount: number },
) {
  return withXeroRetry(async () => {
    const body = await xeroPostJson<{ Allocations?: unknown[] }>(
      config,
      `/CreditNotes/${input.creditNoteId}/Allocations`,
      {
        Allocations: [
          {
            Invoice: { InvoiceID: input.invoiceId },
            Amount: input.amount,
          },
        ],
      },
    );
    return { allocation: body.Allocations?.[0] ?? null };
  });
}

export async function allocatePaymentWithFetch(
  config: XeroFetchConfig,
  input: { paymentId: string; invoiceId: string; amount: number },
) {
  return withXeroRetry(async () => {
    const body = await xeroPostJson<{ Payments?: InvoiceRow[] }>(config, `/Payments/${input.paymentId}`, {
      Payments: [
        {
          PaymentID: input.paymentId,
          Allocations: [
            {
              Invoice: { InvoiceID: input.invoiceId },
              Amount: input.amount,
            },
          ],
        },
      ],
    });
    return { payment: body.Payments?.[0] ?? null };
  });
}

export async function createContactWithFetch(
  config: XeroFetchConfig,
  input: {
    name: string;
    email?: string;
    phone?: string;
    isCustomer?: boolean;
    isSupplier?: boolean;
  },
) {
  return withXeroRetry(async () => {
    const body = await xeroPostJson<{ Contacts?: InvoiceRow[] }>(config, "/Contacts", {
      Contacts: [
        {
          Name: input.name,
          EmailAddress: input.email,
          Phones: input.phone ? [{ PhoneType: "DEFAULT", PhoneNumber: input.phone }] : undefined,
          IsCustomer: input.isCustomer ?? true,
          IsSupplier: input.isSupplier ?? false,
        },
      ],
    });
    return { contact: contactFromBody(body) };
  });
}

export async function deleteDraftInvoiceWithFetch(
  config: XeroFetchConfig,
  input: { invoiceId: string; type: "ACCREC" | "ACCPAY" },
) {
  return withXeroRetry(async () => {
    const body = await xeroPostJson<{ Invoices?: InvoiceRow[] }>(config, "/Invoices", {
      Invoices: [{ InvoiceID: input.invoiceId, Type: input.type, Status: "DELETED" }],
    });
    return { invoice: invoiceFromBody(body) };
  });
}

export async function deleteDraftCreditNoteWithFetch(
  config: XeroFetchConfig,
  input: { creditNoteId: string },
) {
  return withXeroRetry(async () => {
    const body = await xeroPostJson<{ CreditNotes?: InvoiceRow[] }>(config, "/CreditNotes", {
      CreditNotes: [{ CreditNoteID: input.creditNoteId, Status: "DELETED" }],
    });
    return { creditNote: creditNoteFromBody(body) };
  });
}

export async function voidInvoiceWithFetch(
  config: XeroFetchConfig,
  input: { invoiceId: string; type: "ACCREC" | "ACCPAY" },
) {
  return withXeroRetry(async () => {
    const body = await xeroPostJson<{ Invoices?: InvoiceRow[] }>(config, "/Invoices", {
      Invoices: [{ InvoiceID: input.invoiceId, Type: input.type, Status: "VOIDED" }],
    });
    return { invoice: invoiceFromBody(body) };
  });
}

export async function voidCreditNoteWithFetch(
  config: XeroFetchConfig,
  input: { creditNoteId: string },
) {
  return withXeroRetry(async () => {
    const body = await xeroPostJson<{ CreditNotes?: InvoiceRow[] }>(config, "/CreditNotes", {
      CreditNotes: [{ CreditNoteID: input.creditNoteId, Status: "VOIDED" }],
    });
    return { creditNote: creditNoteFromBody(body) };
  });
}
