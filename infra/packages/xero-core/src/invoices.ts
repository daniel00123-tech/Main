import {
  daysBetweenIso,
  isBeforeIsoDate,
  normalizeXeroDate,
  resolveEffectiveDate,
} from "./dates";

export type InvoiceDocumentType = "ACCREC" | "ACCPAY" | "ALL";

export const EXCLUDED_INVOICE_STATUSES = new Set(["VOIDED", "DELETED", "DRAFT", "SUBMITTED"]);

export const SALES_SEMANTICS = {
  invoicedSales:
    "INVOICED SALES — total ACCREC customer invoice value raised in the period (excludes supplier bills).",
  pnlSales:
    "P&L SALES — amount posted to Sales nominal accounts in the Profit & Loss report (may differ when line items use non-sales accounts).",
  totalAccountingIncome:
    "TOTAL ACCOUNTING INCOME — all income accounts on the P&L, including interest and other income.",
  note:
    "Customer invoices raised, P&L Sales nominal, and total accounting income are not equivalent. A sales invoice line coded to Interest Income appears in invoiced sales but not in P&L Sales.",
} as const;

export function normalizeInvoiceTypeFilter(input?: string | null): InvoiceDocumentType {
  const value = String(input ?? "ALL")
    .trim()
    .toUpperCase();
  if (value === "ACCREC" || value === "ACCPAY") return value;
  return "ALL";
}

export function invoiceTypeWhereClause(type: InvoiceDocumentType): string | null {
  if (type === "ACCREC") return 'Type=="ACCREC"';
  if (type === "ACCPAY") return 'Type=="ACCPAY"';
  return null;
}

export function isExcludedInvoiceStatus(status: unknown): boolean {
  return EXCLUDED_INVOICE_STATUSES.has(String(status ?? "").trim().toUpperCase());
}

export function invoiceHasOutstandingBalance(invoice: Record<string, unknown>): boolean {
  if (isExcludedInvoiceStatus(invoice.Status)) return false;
  return Number(invoice.AmountDue ?? 0) > 0;
}

/** Overdue sales invoice: ACCREC, balance due, due date strictly before effective date. */
export function isOverdueSalesInvoice(
  invoice: Record<string, unknown>,
  effectiveDate: string,
): boolean {
  if (String(invoice.Type ?? "") !== "ACCREC") return false;
  if (isExcludedInvoiceStatus(invoice.Status)) return false;
  if (Number(invoice.AmountDue ?? 0) <= 0) return false;
  const dueDate = normalizeXeroDate(invoice.DueDate);
  if (!dueDate) return false;
  return isBeforeIsoDate(dueDate, effectiveDate);
}

export function isOutstandingSalesInvoice(invoice: Record<string, unknown>): boolean {
  return String(invoice.Type ?? "") === "ACCREC" && invoiceHasOutstandingBalance(invoice);
}

export function isOutstandingPurchaseBill(invoice: Record<string, unknown>): boolean {
  return String(invoice.Type ?? "") === "ACCPAY" && invoiceHasOutstandingBalance(invoice);
}

export function filterInvoicesByType<T extends { Type?: unknown }>(
  rows: T[],
  type: InvoiceDocumentType,
): T[] {
  if (type === "ALL") return rows;
  return rows.filter((row) => String(row.Type ?? "") === type);
}

export type FormattedInvoiceSummary = {
  invoiceId: string | null;
  invoiceNumber: string | null;
  documentType: "sales_invoice" | "supplier_bill" | "unknown";
  customerOrSupplier: string | null;
  contactId: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  status: string | null;
  total: number | null;
  amountPaid: number | null;
  amountDue: number;
  daysOverdue: number;
  currencyCode: string | null;
};

export function documentTypeLabel(type: string | null): FormattedInvoiceSummary["documentType"] {
  if (type === "ACCREC") return "sales_invoice";
  if (type === "ACCPAY") return "supplier_bill";
  return "unknown";
}

export function formatInvoiceSummary(
  invoice: Record<string, unknown>,
  effectiveDate?: string,
): FormattedInvoiceSummary {
  const effective = resolveEffectiveDate(effectiveDate);
  const dueDate = normalizeXeroDate(invoice.DueDate);
  const invoiceDate = normalizeXeroDate(invoice.Date);
  const contact = invoice.Contact as Record<string, unknown> | undefined;
  const amountDue = Number(invoice.AmountDue ?? 0);
  const daysOverdue =
    dueDate && isBeforeIsoDate(dueDate, effective) ? daysBetweenIso(dueDate, effective) : 0;
  const xeroType = invoice.Type ? String(invoice.Type) : null;

  return {
    invoiceId: invoice.InvoiceID ? String(invoice.InvoiceID) : null,
    invoiceNumber: invoice.InvoiceNumber ? String(invoice.InvoiceNumber) : null,
    documentType: documentTypeLabel(xeroType),
    customerOrSupplier: contact?.Name ? String(contact.Name) : null,
    contactId: contact?.ContactID ? String(contact.ContactID) : null,
    invoiceDate,
    dueDate,
    status: invoice.Status ? String(invoice.Status) : null,
    total: invoice.Total != null ? Number(invoice.Total) : null,
    amountPaid: invoice.AmountPaid != null ? Number(invoice.AmountPaid) : null,
    amountDue,
    daysOverdue,
    currencyCode: invoice.CurrencyCode ? String(invoice.CurrencyCode) : null,
  };
}

export function sortOverdueInvoices<T extends { daysOverdue: number; dueDate: string | null }>(
  rows: T[],
): T[] {
  return [...rows].sort((a, b) => {
    if (b.daysOverdue !== a.daysOverdue) return b.daysOverdue - a.daysOverdue;
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    return 0;
  });
}

export function buildOutstandingSalesInvoiceWhere(input: {
  contactId?: string;
}): string {
  const clauses = ['Type=="ACCREC"', "AmountDue>0"];
  if (input.contactId) clauses.push(`Contact.ContactID=guid("${input.contactId}")`);
  return clauses.join(" AND ");
}
