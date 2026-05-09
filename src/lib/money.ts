import { Prisma } from "@/generated/prisma/client";

export type MoneyInput = number | string | Prisma.Decimal;

export function toDecimal(value: MoneyInput): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

export function toNumber(value: MoneyInput): number {
  return Number(value.toString());
}

export function roundMoney(value: MoneyInput): Prisma.Decimal {
  return new Prisma.Decimal(value).toDecimalPlaces(2);
}

export function formatCurrency(value: MoneyInput): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP"
  }).format(toNumber(value));
}
