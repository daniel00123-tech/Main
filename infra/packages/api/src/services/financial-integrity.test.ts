import { describe, expect, it, vi } from "vitest";
import { creditAutoTopUpFromPaymentIntent } from "./auto-topup";

vi.mock("./ledger", () => ({
  appendLedgerEntry: vi.fn(async () => ({
    alreadyExists: false,
    entry: { id: "le_1", balanceAfterCents: 5000 },
  })),
  getWalletBalance: vi.fn(),
}));

vi.mock("./control-plane", () => ({
  recordAuditEvent: vi.fn(async () => undefined),
}));

vi.mock("./notifications", () => ({
  createNotification: vi.fn(async () => ({ id: "n1", created: true })),
}));

function mockEnv(db: D1Database) {
  return { DB: db, STRIPE_SECRET_KEY: "sk_test_x" } as never;
}

describe("financial integrity — auto top-up", () => {
  it("credits wallet exactly once from webhook path", async () => {
    const runs: string[] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () => {
            if (sql.includes("auto_top_up_transactions") && sql.includes("stripe_payment_intent")) {
              return { id: "tx_1", ledger_entry_id: null };
            }
            return null;
          },
          run: async () => {
            runs.push(sql.slice(0, 40));
            return { success: true };
          },
        }),
      }),
    } as unknown as D1Database;

    const env = mockEnv(db);
    const first = await creditAutoTopUpFromPaymentIntent(env, {
      stripeEventId: "evt_1",
      paymentIntentId: "pi_1",
      companyId: "co_test",
      amountCents: 2500,
    });
    expect(first.credited).toBe(true);
    expect(first.duplicate).toBe(false);

    const { appendLedgerEntry } = await import("./ledger");
    vi.mocked(appendLedgerEntry).mockResolvedValueOnce({
      alreadyExists: true,
      entry: { id: "le_1", balanceAfterCents: 5000 },
    } as never);

    const db2 = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () => {
            if (sql.includes("auto_top_up_transactions")) {
              return { id: "tx_1", ledger_entry_id: "le_1" };
            }
            return null;
          },
          run: async () => ({ success: true }),
        }),
      }),
    } as unknown as D1Database;

    const second = await creditAutoTopUpFromPaymentIntent(mockEnv(db2), {
      stripeEventId: "evt_1",
      paymentIntentId: "pi_1",
      companyId: "co_test",
      amountCents: 2500,
    });
    expect(second.duplicate).toBe(true);
    expect(second.credited).toBe(false);
  });
});

describe("financial integrity — invariants", () => {
  it("STRIPE_LIVE_MODE_ALLOWED is enabled for operator-approved live acceptance", async () => {
    const { STRIPE_LIVE_MODE_ALLOWED } = await import("./stripe");
    expect(STRIPE_LIVE_MODE_ALLOWED).toBe(true);
  });
});
