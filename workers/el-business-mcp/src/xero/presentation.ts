export const GBP = "GBP";

export const XERO_PNL_VAT_NOTE =
  "Xero Profit and Loss figures are exclusive of VAT/GST. Do not divide by 1.2 or treat invoice Totals as interchangeable with P&L revenue.";

export function roundMoney(amount: number): number {
  return Number(amount.toFixed(2));
}

export function formatGbp(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return "unavailable";
  return `£${amount.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function salesHeadline(periodLabel: string, amount: number | null | undefined): string {
  return `${periodLabel} sales are ${formatGbp(amount)} excluding VAT.`;
}

export function invoiceActivityHeadline(
  periodLabel: string,
  netExVat: number | null | undefined,
  netIncVat: number | null | undefined
): string {
  return `${periodLabel} net invoices raised are ${formatGbp(netExVat)} excluding VAT (${formatGbp(netIncVat)} including VAT).`;
}

export function cashHeadline(periodLabel: string, amount: number | null | undefined): string {
  return `${periodLabel} cash received from customers is ${formatGbp(amount)} (includes VAT where the invoices were taxable).`;
}

export function outstandingHeadline(amount: number | null | undefined): string {
  return `Outstanding customer debt is ${formatGbp(amount)} including VAT.`;
}
