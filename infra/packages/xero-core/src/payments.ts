import {
  isOnOrAfterIsoDate,
  isOnOrBeforeIsoDate,
  normalizeXeroDate,
  toXeroDateTimeClause,
} from "./dates";

export type PaymentDirection = "customer_receipt" | "supplier_payment" | "unknown";

export type FormattedPaymentSummary = {
  paymentId: string | null;
  paymentDate: string | null;
  amount: number | null;
  direction: PaymentDirection;
  directionLabel: string;
  invoiceNumber: string | null;
  invoiceType: string | null;
  contactName: string | null;
  currencyCode: string | null;
  reference: string | null;
};

export function classifyPaymentDirection(payment: Record<string, unknown>): PaymentDirection {
  const invoice = payment.Invoice as Record<string, unknown> | undefined;
  const type = String(invoice?.Type ?? "").toUpperCase();
  if (type === "ACCREC") return "customer_receipt";
  if (type === "ACCPAY") return "supplier_payment";
  return "unknown";
}

export function paymentDirectionLabel(direction: PaymentDirection): string {
  if (direction === "customer_receipt") return "Customer receipt";
  if (direction === "supplier_payment") return "Supplier payment";
  return "Unknown payment type";
}

export function normalizePaymentDate(payment: Record<string, unknown>): string | null {
  return normalizeXeroDate(payment.Date);
}

/** Authoritative inclusive filter on actual payment transaction date. */
export function filterPaymentsByTransactionDate(
  payments: Record<string, unknown>[],
  startDate: string,
  endDate: string,
): Record<string, unknown>[] {
  return payments.filter((payment) => {
    const paymentDate = normalizePaymentDate(payment);
    if (!paymentDate) return false;
    return isOnOrAfterIsoDate(paymentDate, startDate) && isOnOrBeforeIsoDate(paymentDate, endDate);
  });
}

export function filterPaymentsByDirection(
  payments: Record<string, unknown>[],
  direction: PaymentDirection,
): Record<string, unknown>[] {
  return payments.filter((payment) => classifyPaymentDirection(payment) === direction);
}

export function buildPaymentDateWhere(startDate: string, endDate: string): string {
  return `Date>=${toXeroDateTimeClause(startDate)} AND Date<=${toXeroDateTimeClause(endDate)}`;
}

export function formatPaymentSummary(payment: Record<string, unknown>): FormattedPaymentSummary {
  const direction = classifyPaymentDirection(payment);
  const invoice = payment.Invoice as Record<string, unknown> | undefined;
  const contact = payment.Contact as Record<string, unknown> | undefined;
  return {
    paymentId: payment.PaymentID ? String(payment.PaymentID) : null,
    paymentDate: normalizePaymentDate(payment),
    amount: payment.Amount != null ? Number(payment.Amount) : null,
    direction,
    directionLabel: paymentDirectionLabel(direction),
    invoiceNumber: invoice?.InvoiceNumber ? String(invoice.InvoiceNumber) : null,
    invoiceType: invoice?.Type ? String(invoice.Type) : null,
    contactName: contact?.Name
      ? String(contact.Name)
      : invoice && (invoice.Contact as Record<string, unknown> | undefined)?.Name
        ? String((invoice.Contact as Record<string, unknown>).Name)
        : null,
    currencyCode: payment.CurrencyCode ? String(payment.CurrencyCode) : null,
    reference: payment.Reference ? String(payment.Reference) : null,
  };
}

export function sumPaymentAmounts(payments: Record<string, unknown>[]): number {
  let total = 0;
  for (const payment of payments) {
    total += Number(payment.Amount ?? 0);
  }
  return total;
}
