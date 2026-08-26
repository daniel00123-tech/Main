import type { CreditClass } from "@infra/shared";
import type { LedgerEntry } from "./ledger";

export function creditClassForEntry(entry: LedgerEntry): CreditClass | null {
  const meta = entry.metadata ?? {};
  if (meta.creditClass === "paid" || meta.creditClass === "test") {
    return meta.creditClass;
  }
  if (entry.entryType === "top_up") return "paid";
  if (entry.entryType === "promotional_credit") return "test";
  if (entry.entryType === "manual_credit") {
    return meta.paid === true ? "paid" : "test";
  }
  return null;
}

export function classifyLedgerCredit(entries: LedgerEntry[]): {
  testCents: number;
  paidCents: number;
} {
  let testCents = 0;
  let paidCents = 0;
  for (const entry of entries) {
    if (entry.amountCents <= 0) continue;
    const cls = creditClassForEntry(entry);
    if (cls === "paid") paidCents += entry.amountCents;
    else if (cls === "test") testCents += entry.amountCents;
  }
  return { testCents, paidCents };
}
