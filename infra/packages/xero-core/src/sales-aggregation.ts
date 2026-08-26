/** Xero accounting direction for invoices and credit notes. */
export type XeroTransactionType =
  | "ACCREC"
  | "ACCPAY"
  | "ACCRECCREDIT"
  | "ACCPAYCREDIT"
  | string;

export type SalesDocumentKind = "invoice" | "credit_note";

export type RawSalesDocument = {
  documentKind: SalesDocumentKind;
  documentId?: string | null;
  documentNumber?: string | null;
  contactId?: string | null;
  contactName?: string | null;
  transactionType?: string | null;
  status?: string | null;
  date?: string | null;
  total?: number | null;
};

export type ClassifiedSalesDocument = {
  documentKind: SalesDocumentKind;
  documentId: string | null;
  documentNumber: string | null;
  contactId: string | null;
  contactName: string;
  transactionType: string;
  status: string;
  date: string | null;
  amount: number;
  salesContribution: number;
  qualifiesForSales: boolean;
  exclusionReason: string | null;
};

const EXCLUDED_STATUSES = new Set(["VOIDED", "DELETED"]);
const SALES_TYPES = new Set(["ACCREC", "ACCRECCREDIT"]);
const PURCHASE_TYPES = new Set(["ACCPAY", "ACCPAYCREDIT"]);

export function isSalesTransactionType(type: string): boolean {
  return SALES_TYPES.has(type);
}

export function isPurchaseTransactionType(type: string): boolean {
  return PURCHASE_TYPES.has(type);
}

export function salesContributionForType(type: string, total: number): number {
  if (type === "ACCREC") return total;
  if (type === "ACCRECCREDIT") return -Math.abs(total);
  return 0;
}

export function classifySalesDocument(raw: RawSalesDocument): ClassifiedSalesDocument {
  const transactionType = String(raw.transactionType ?? "").trim() || "UNKNOWN";
  const status = String(raw.status ?? "").trim() || "UNKNOWN";
  const amount = Number(raw.total ?? 0);
  const contactName = raw.contactName?.trim() || "No Contact";

  let qualifiesForSales = false;
  let exclusionReason: string | null = null;

  if (EXCLUDED_STATUSES.has(status)) {
    exclusionReason = `status_${status.toLowerCase()}`;
  } else if (isPurchaseTransactionType(transactionType)) {
    exclusionReason =
      transactionType === "ACCPAY"
        ? "purchase_invoice"
        : "purchase_credit_note";
  } else if (!isSalesTransactionType(transactionType)) {
    exclusionReason = "unknown_transaction_type";
  } else if (status === "DRAFT" || status === "SUBMITTED") {
    exclusionReason = `status_${status.toLowerCase()}`;
  } else {
    qualifiesForSales = true;
  }

  const salesContribution = qualifiesForSales
    ? salesContributionForType(transactionType, amount)
    : 0;

  return {
    documentKind: raw.documentKind,
    documentId: raw.documentId ? String(raw.documentId) : null,
    documentNumber: raw.documentNumber ? String(raw.documentNumber) : null,
    contactId: raw.contactId ? String(raw.contactId) : null,
    contactName,
    transactionType,
    status,
    date: raw.date ? String(raw.date) : null,
    amount,
    salesContribution,
    qualifiesForSales,
    exclusionReason,
  };
}

export function classifySalesDocuments(rows: RawSalesDocument[]): ClassifiedSalesDocument[] {
  return rows.map(classifySalesDocument);
}

export type SalesAggregation = {
  totalSales: number;
  qualifyingTransactionCount: number;
  excludedTransactionCount: number;
  transactions: ClassifiedSalesDocument[];
  excludedTransactions: ClassifiedSalesDocument[];
};

export function aggregateSales(documents: ClassifiedSalesDocument[]): SalesAggregation {
  const transactions = documents.filter((doc) => doc.qualifiesForSales);
  const excludedTransactions = documents.filter((doc) => !doc.qualifiesForSales);
  let totalSales = 0;
  for (const doc of transactions) totalSales += doc.salesContribution;
  return {
    totalSales,
    qualifyingTransactionCount: transactions.length,
    excludedTransactionCount: excludedTransactions.length,
    transactions,
    excludedTransactions,
  };
}

export type CustomerTotal = {
  contactId: string;
  name: string;
  total: number;
  transactionCount: number;
};

export function aggregateTopCustomers(
  documents: ClassifiedSalesDocument[],
  limit: number,
): CustomerTotal[] {
  const totals = new Map<string, CustomerTotal>();
  for (const doc of documents) {
    if (!doc.qualifiesForSales) continue;
    const contactId = doc.contactId ?? "unknown";
    const existing = totals.get(contactId) ?? {
      contactId,
      name: doc.contactName,
      total: 0,
      transactionCount: 0,
    };
    existing.total += doc.salesContribution;
    existing.transactionCount += 1;
    totals.set(contactId, existing);
  }
  return [...totals.values()]
    .filter((row) => row.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

export function mapInvoiceRow(invoice: Record<string, unknown>): RawSalesDocument {
  const contact = invoice.Contact as Record<string, unknown> | undefined;
  return {
    documentKind: "invoice",
    documentId: invoice.InvoiceID ? String(invoice.InvoiceID) : null,
    documentNumber: invoice.InvoiceNumber ? String(invoice.InvoiceNumber) : null,
    contactId: contact?.ContactID ? String(contact.ContactID) : null,
    contactName: contact?.Name ? String(contact.Name) : null,
    transactionType: invoice.Type ? String(invoice.Type) : null,
    status: invoice.Status ? String(invoice.Status) : null,
    date: invoice.Date ? String(invoice.Date) : null,
    total: invoice.Total != null ? Number(invoice.Total) : null,
  };
}

export function mapCreditNoteRow(note: Record<string, unknown>): RawSalesDocument {
  const contact = note.Contact as Record<string, unknown> | undefined;
  return {
    documentKind: "credit_note",
    documentId: note.CreditNoteID ? String(note.CreditNoteID) : null,
    documentNumber: note.CreditNoteNumber ? String(note.CreditNoteNumber) : null,
    contactId: contact?.ContactID ? String(contact.ContactID) : null,
    contactName: contact?.Name ? String(contact.Name) : null,
    transactionType: note.Type ? String(note.Type) : null,
    status: note.Status ? String(note.Status) : null,
    date: note.Date ? String(note.Date) : null,
    total: note.Total != null ? Number(note.Total) : null,
  };
}

export function dateRangeWhere(fromDate: string, toDate: string): string {
  const from = fromDate.replace(/-/g, ",");
  const to = toDate.replace(/-/g, ",");
  return `Date>=DateTime(${from}) AND Date<=DateTime(${to})`;
}
