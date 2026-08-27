import { describe, expect, it } from "vitest";
import {
  deriveWalletHealthState,
  getMonthStartUtcIso,
  getSpendThisMonthCents,
} from "./wallet-metrics";

describe("wallet-metrics", () => {
  it("derives wallet health states from balance and threshold", () => {
    expect(deriveWalletHealthState(0, 500)).toBe("empty");
    expect(deriveWalletHealthState(-10, 500)).toBe("empty");
    expect(deriveWalletHealthState(200, 500)).toBe("critical");
    expect(deriveWalletHealthState(400, 500)).toBe("low");
    expect(deriveWalletHealthState(500, 500)).toBe("healthy");
    expect(deriveWalletHealthState(2940, 500)).toBe("healthy");
  });

  it("computes month start in UTC", () => {
    const start = getMonthStartUtcIso(new Date("2026-08-27T12:00:00.000Z"));
    expect(start).toBe("2026-08-01T00:00:00.000Z");
  });

  it("aggregates spend from full ledger not a limited slice", async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ spend: 63 }),
        }),
      }),
    } as unknown as D1Database;

    const spend = await getSpendThisMonthCents(db, "co_test");
    expect(spend).toBe(63);
  });
});
