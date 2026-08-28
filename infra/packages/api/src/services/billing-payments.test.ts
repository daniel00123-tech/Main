import { describe, expect, it } from "vitest";
import { listBillingPayments } from "./billing-payments";

class FakeStatement {
  constructor(
    private db: FakeD1,
    private sql: string,
    private binds: unknown[] = [],
  ) {}

  bind(...args: unknown[]) {
    return new FakeStatement(this.db, this.sql, args);
  }

  async all() {
    return { results: this.db.all(this.sql, this.binds) };
  }
}

class FakeD1 {
  entries: Array<Record<string, unknown>>;
  constructor(entries: Array<Record<string, unknown>>) {
    this.entries = entries;
  }
  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }
  all(sql: string, binds: unknown[]) {
    if (sql.includes("FROM ledger_entries")) {
      return this.entries.filter((e) => e.company_id === binds[0]);
    }
    return [];
  }
}

describe("listBillingPayments", () => {
  it("labels sandbox Stripe top-ups as test with live receipt base omitted", async () => {
    const db = new FakeD1([
      {
        id: "ledger_test",
        company_id: "co_caddington",
        entry_type: "top_up",
        amount_cents: 1000,
        currency: "GBP",
        balance_after_cents: 2000,
        reference_type: "stripe_checkout",
        reference_id: "stripe_co_test",
        description: "Stripe top-up £10.00",
        metadata_json: JSON.stringify({
          creditClass: "paid",
          stripeMode: "test",
          stripePaymentIntentId: "pi_test_123",
          stripeSessionId: "cs_test_abc",
        }),
        created_by: "stripe-webhook",
        created_at: "2026-08-27T08:15:07.531Z",
      },
      {
        id: "ledger_live",
        company_id: "co_caddington",
        entry_type: "top_up",
        amount_cents: 100,
        currency: "GBP",
        balance_after_cents: 2907,
        reference_type: "stripe_checkout",
        reference_id: "stripe_co_live",
        description: "Stripe top-up £1.00",
        metadata_json: JSON.stringify({
          creditClass: "paid",
          stripeMode: "live",
          stripePaymentIntentId: "pi_live_123",
          stripeSessionId: "cs_live_abc",
        }),
        created_by: "stripe-webhook",
        created_at: "2026-08-28T19:22:36.217Z",
      },
    ]) as unknown as D1Database;

    const payments = await listBillingPayments(db, "co_caddington");
    const sandbox = payments.find((p) => p.id === "ledger_test");
    const live = payments.find((p) => p.id === "ledger_live");
    expect(sandbox?.creditClass).toBe("test");
    expect(sandbox?.stripeMode).toBe("test");
    expect(sandbox?.receiptUrl).toContain("/test/payments/");
    expect(live?.creditClass).toBe("paid");
    expect(live?.stripeMode).toBe("live");
    expect(live?.receiptUrl).toContain("https://dashboard.stripe.com/payments/");
    expect(live?.receiptUrl).not.toContain("/test/");
  });
});
