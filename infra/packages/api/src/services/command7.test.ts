import { describe, expect, it, vi } from "vitest";
import { findActiveInvitation } from "./invitations";
import { DIRECT_MCP_FINANCIAL_WRITES_BLOCKED, FINANCIAL_WRITES_ENABLED } from "./approvals";
import { isXeroWriteToolName } from "./xero-tools";
import { allocateDebitCreditClasses } from "./promotional-grants";

describe("Command 7 — financial permission architecture", () => {
  it("keeps Action Engine execution enabled while direct MCP writes stay blocked", () => {
    expect(FINANCIAL_WRITES_ENABLED).toBe(true);
    expect(DIRECT_MCP_FINANCIAL_WRITES_BLOCKED).toBe(true);
    expect(isXeroWriteToolName("xero_create_draft_invoice")).toBe(true);
    expect(isXeroWriteToolName("xero_get_organisation")).toBe(false);
  });
});

describe("Command 7 — duplicate invitation guard", () => {
  it("finds pending non-expired invitation for email", async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({
            id: "inv_1",
            email: "user@example.com",
            status: "pending",
          }),
        }),
      }),
    } as unknown as D1Database;

    const row = await findActiveInvitation(db, "co_a", "user@example.com");
    expect(row?.id).toBe("inv_1");
  });
});

describe("Command 7 — promotional-first consumption", () => {
  it("allocates debit to promotional credit before paid", async () => {
    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () => {
            if (sql.includes("promotional_credit_grants")) {
              return { total: 1000 };
            }
            return null;
          },
          all: async () => ({
            results: [{ id: "pg1", remaining_cents: 1000 }],
          }),
          run: async () => ({ success: true }),
        }),
      }),
    } as unknown as D1Database;

    const allocation = await allocateDebitCreditClasses(db, "co_a", 100);
    expect(allocation.promotionalCents).toBe(100);
    expect(allocation.paidCents).toBe(0);
  });

  it("splits debit across promotional and paid when promotional insufficient", async () => {
    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () => {
            if (sql.includes("SUM(remaining_cents)")) return { total: 50 };
            return null;
          },
          all: async () => ({
            results: [{ id: "pg1", remaining_cents: 50 }],
          }),
          run: async () => ({ success: true }),
        }),
      }),
    } as unknown as D1Database;

    const allocation = await allocateDebitCreditClasses(db, "co_a", 100);
    expect(allocation.promotionalCents).toBe(50);
    expect(allocation.paidCents).toBe(50);
  });
});

describe("Command 7 — payment method reconciliation", () => {
  it("ensurePaymentProviderAccount creates row before metadata update", async () => {
    const { ensurePaymentProviderAccount } = await import("./payment-providers");
    const inserts: string[] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          run: async () => {
            inserts.push(sql.toLowerCase());
            return { success: true };
          },
        }),
      }),
    } as unknown as D1Database;

    await ensurePaymentProviderAccount(db, "co_a", "stripe");
    expect(inserts.some((s) => s.includes("insert or ignore into payment_provider_accounts"))).toBe(
      true,
    );
  });
});
