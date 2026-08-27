import { describe, expect, it, vi } from "vitest";
import { evaluateAutoTopUp, AUTO_TOPUP_MAX_AMOUNT_CENTS } from "./auto-topup";

function mockDb(rows: Record<string, Record<string, unknown>>) {
  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          if (sql.includes("payment_provider_accounts") && sql.includes("payment_method")) {
            return rows.provider ?? null;
          }
          if (sql.includes("auto_top_up_transactions") && sql.includes("ledger_entry_id")) {
            return rows.awaitingWebhook ?? null;
          }
          if (sql.includes("auto_top_up_transactions") && sql.includes("pending")) {
            return rows.pending ?? null;
          }
          if (sql.includes("auto_top_up_transactions") && sql.includes("completed")) {
            return rows.recent ?? null;
          }
          if (sql.includes("company_commercial_settings")) {
            return rows.commercial ?? null;
          }
          return null;
        },
        all: async () => ({ results: [] }),
        run: async () => ({ success: true }),
      }),
    }),
  } as unknown as D1Database;
}

vi.mock("./control-plane", () => ({
  recordAuditEvent: vi.fn(async () => undefined),
}));

vi.mock("./company-settings", () => ({
  getCompanySettings: vi.fn(async () => ({
    autoTopUp: { enabled: true, thresholdCents: 500, amountCents: 2500 },
  })),
}));

vi.mock("./ledger", () => ({
  getWalletBalance: vi.fn(async () => ({ balanceCents: 300 })),
}));

describe("evaluateAutoTopUp", () => {
  it("returns disabled when auto top-up off", async () => {
    const { getCompanySettings } = await import("./company-settings");
    vi.mocked(getCompanySettings).mockResolvedValueOnce({
      companyId: "c1",
      name: "Test",
      autoTopUp: { enabled: false, thresholdCents: 500, amountCents: 2500, paymentMethodReady: true },
    } as never);

    const result = await evaluateAutoTopUp(mockDb({}), "c1");
    expect(result.shouldExecute).toBe(false);
    expect(result.reason).toBe("auto_topup_disabled");
  });

  it("returns no_payment_method when card not saved", async () => {
    const result = await evaluateAutoTopUp(
      mockDb({
        provider: { payment_method_id: null, payment_method_status: "none" },
      }),
      "c1",
    );
    expect(result.shouldExecute).toBe(false);
    expect(result.reason).toBe("no_payment_method");
  });

  it("returns eligible when balance below threshold", async () => {
    const result = await evaluateAutoTopUp(
      mockDb({
        provider: {
          payment_method_id: "pm_1",
          payment_method_status: "active",
          auto_top_up_enabled: 1,
        },
        commercial: {
          auto_top_up_monthly_cap_cents: null,
          auto_top_up_monthly_spent_cents: 0,
          auto_top_up_month_key: "2026-08",
          auto_top_up_daily_cap_cents: null,
          auto_top_up_daily_spent_cents: 0,
          auto_top_up_day_key: "2026-08-27",
          auto_top_up_failed_count: 0,
          auto_top_up_suppressed_until: null,
        },
      }),
      "c1",
    );
    expect(result.shouldExecute).toBe(true);
    expect(result.amountCents).toBe(2500);
  });

  it("respects maximum amount cap constant", () => {
    expect(AUTO_TOPUP_MAX_AMOUNT_CENTS).toBe(10000_00);
  });
});
