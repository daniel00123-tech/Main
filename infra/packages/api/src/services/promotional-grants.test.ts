import { describe, expect, it, vi } from "vitest";
import { grantPromotionalCredit } from "./promotional-grants";

vi.mock("./control-plane", () => ({
  recordAuditEvent: vi.fn(async () => undefined),
}));

vi.mock("./ledger", () => ({
  appendLedgerEntry: vi.fn(async (_db, input) => ({
    entry: {
      id: "ledger_1",
      companyId: input.companyId,
      entryType: input.entryType,
      amountCents: input.amountCents,
      metadata: input.metadata,
    },
    balanceAfterCents: input.amountCents,
  })),
}));

describe("promotional grants", () => {
  it("creates company-scoped ledger + grant without Stripe", async () => {
    const db = {
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({
          run: async () => {
            if (sql.includes("INSERT INTO promotional_credit_grants")) {
              expect(binds[1]).toBe("co_a");
              expect(binds[5]).toBe("Acceptance probe");
              expect(binds[7]).toBe("admin@test.com");
            }
            return { success: true };
          },
        }),
      }),
    } as unknown as D1Database;

    const { appendLedgerEntry } = await import("./ledger");
    const result = await grantPromotionalCredit(db, {
      companyId: "co_a",
      amountCents: 500,
      reason: "Acceptance probe",
      grantedBy: "admin@test.com",
    });

    expect(vi.mocked(appendLedgerEntry)).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        companyId: "co_a",
        entryType: "promotional_credit",
        metadata: expect.objectContaining({
          creditClass: "test",
          grantedBy: "admin@test.com",
        }),
      }),
    );
    expect(result.grantId).toBeTruthy();
  });
});
