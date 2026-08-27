/** Supplier bill aggregation — ACCPAY only (mirror of sales-aggregation for purchases). */
import { normalizeXeroDate } from "./dates";

export type RawPurchaseDocument = {
  documentId?: string | null;
  documentNumber?: string | null;
  contactId?: string | null;
  contactName?: string | null;
  transactionType?: string | null;
  status?: string | null;
  date?: string | null;
  total?: number | null;
};

export type ClassifiedPurchaseDocument = {
  documentId: string | null;
  documentNumber: string | null;
  contactId: string | null;
  contactName: string;
  transactionType: string;
  status: string;
  date: string | null;
  amount: number;
  purchaseContribution: number;
  qualifiesForPurchase: boolean;
  exclusionReason: string | null;
};

const EXCLUDED_STATUSES = new Set(["VOIDED", "DELETED"]);
const PURCHASE_TYPES = new Set(["ACCPAY"]);

export function classifyPurchaseDocument(raw: RawPurchaseDocument): ClassifiedPurchaseDocument {
  const transactionType = String(raw.transactionType ?? "").trim() || "UNKNOWN";
  const status = String(raw.status ?? "").trim() || "UNKNOWN";
  const amount = Number(raw.total ?? 0);
  const contactName = raw.contactName?.trim() || "No Contact";

  let qualifiesForPurchase = false;
  let exclusionReason: string | null = null;

  if (EXCLUDED_STATUSES.has(status)) {
    exclusionReason = `status_${status.toLowerCase()}`;
  } else if (transactionType === "ACCREC" || transactionType === "ACCRECCREDIT") {
    exclusionReason = "sales_invoice";
  } else if (!PURCHASE_TYPES.has(transactionType)) {
    exclusionReason = "unknown_transaction_type";
  } else if (status === "DRAFT" || status === "SUBMITTED") {
    exclusionReason = `status_${status.toLowerCase()}`;
  } else {
    qualifiesForPurchase = true;
  }

  return {
    documentId: raw.documentId ? String(raw.documentId) : null,
    documentNumber: raw.documentNumber ? String(raw.documentNumber) : null,
    contactId: raw.contactId ? String(raw.contactId) : null,
    contactName,
    transactionType,
    status,
    date: raw.date ? String(raw.date) : null,
    amount,
    purchaseContribution: qualifiesForPurchase ? amount : 0,
    qualifiesForPurchase,
    exclusionReason,
  };
}

export function classifyPurchaseDocuments(rows: RawPurchaseDocument[]): ClassifiedPurchaseDocument[] {
  return rows.map(classifyPurchaseDocument);
}

export type SupplierTotal = {
  contactId: string;
  name: string;
  total: number;
  billCount: number;
  sharePercent: number;
};

export function aggregateTopSuppliers(
  documents: ClassifiedPurchaseDocument[],
  limit: number,
): SupplierTotal[] {
  const totals = new Map<string, SupplierTotal>();
  let grandTotal = 0;

  for (const doc of documents) {
    if (!doc.qualifiesForPurchase) continue;
    const contactId = doc.contactId ?? "unknown";
    const existing = totals.get(contactId) ?? {
      contactId,
      name: doc.contactName,
      total: 0,
      billCount: 0,
      sharePercent: 0,
    };
    existing.total += doc.purchaseContribution;
    existing.billCount += 1;
    grandTotal += doc.purchaseContribution;
    totals.set(contactId, existing);
  }

  const ranked = [...totals.values()]
    .filter((row) => row.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);

  return ranked.map((row) => ({
    ...row,
    sharePercent: grandTotal > 0 ? Math.round((row.total / grandTotal) * 10000) / 100 : 0,
  }));
}

export function mapPurchaseInvoiceRow(invoice: Record<string, unknown>): RawPurchaseDocument {
  const contact = invoice.Contact as Record<string, unknown> | undefined;
  return {
    documentId: invoice.InvoiceID ? String(invoice.InvoiceID) : null,
    documentNumber: invoice.InvoiceNumber ? String(invoice.InvoiceNumber) : null,
    contactId: contact?.ContactID ? String(contact.ContactID) : null,
    contactName: contact?.Name ? String(contact.Name) : null,
    transactionType: invoice.Type ? String(invoice.Type) : null,
    status: invoice.Status ? String(invoice.Status) : null,
    date: normalizeXeroDate(invoice.Date) ?? undefined,
    total: invoice.Total != null ? Number(invoice.Total) : null,
  };
}
