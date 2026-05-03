export function poundsToPence(value: string | number): number {
  const asNumber = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(asNumber) || asNumber < 0) {
    throw new Error("Amount must be a positive number.");
  }

  return Math.round(asNumber * 100);
}

export function formatMoney(amountInPence: number): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
  }).format(amountInPence / 100);
}

export const formatPounds = formatMoney;
export const formatCurrency = formatMoney;
export const pounds = formatMoney;
