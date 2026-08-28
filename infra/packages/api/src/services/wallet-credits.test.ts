import { describe, expect, it } from "vitest";
import { creditClassForEntry, classifyLedgerCredit } from "./wallet-credits";
import type { LedgerEntry } from "./ledger";

describe("wallet credit classification", () => {
  it("treats Stripe sandbox top-ups as test credit even when metadata says paid", () => {
    const entry: LedgerEntry = {
      id: "ledger_1",
      companyId: "co_test",
      entryType: "top_up",
      amountCents: 1000,
      currency: "GBP",
      balanceAfterCents: 1000,
      referenceType: "stripe_checkout",
      referenceId: "stripe_co_1",
      description: "Stripe top-up",
      metadata: { creditClass: "paid", stripeMode: "test" },
      createdBy: "stripe-webhook",
      createdAt: "2026-08-27T00:00:00.000Z",
    };
    expect(creditClassForEntry(entry)).toBe("test");
    const classified = classifyLedgerCredit([entry]);
    expect(classified.paidCents).toBe(0);
    expect(classified.testCents).toBe(1000);
  });

  it("keeps live Stripe top-ups as paid credit", () => {
    const entry: LedgerEntry = {
      id: "ledger_2",
      companyId: "co_test",
      entryType: "top_up",
      amountCents: 100,
      currency: "GBP",
      balanceAfterCents: 1100,
      referenceType: "stripe_checkout",
      referenceId: "stripe_co_2",
      description: "Stripe top-up",
      metadata: { creditClass: "paid", stripeMode: "live" },
      createdBy: "stripe-webhook",
      createdAt: "2026-08-28T00:00:00.000Z",
    };
    expect(creditClassForEntry(entry)).toBe("paid");
    const classified = classifyLedgerCredit([entry]);
    expect(classified.paidCents).toBe(100);
  });
});
