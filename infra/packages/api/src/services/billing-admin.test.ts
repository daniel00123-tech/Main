import { describe, expect, it } from "vitest";
import {
  getBillingPlatformSummary,
  listEnrichedPlatformBalances,
  listPlatformLedger,
  platformLedgerToCsv,
} from "./billing-admin";

type Row = Record<string, unknown>;

class MockStatement {
  constructor(
    private db: MockD1,
    private sql: string,
    private binds: unknown[] = [],
  ) {}

  bind(...args: unknown[]) {
    return new MockStatement(this.db, this.sql, args);
  }

  async first() {
    const rows = this.db.query(this.sql, this.binds);
    return rows[0] ?? null;
  }

  async all() {
    return { results: this.db.query(this.sql, this.binds) };
  }

  async run() {
    this.db.exec(this.sql, this.binds);
    return { success: true };
  }
}

class MockD1 {
  tables: Record<string, Row[]> = {
    companies: [
      {
        id: "co_1",
        name: "Test Co",
        slug: "test-co",
      },
    ],
    credit_balances: [
      {
        company_id: "co_1",
        balance_cents: 1940,
        currency: "GBP",
        low_balance_threshold_cents: 500,
      },
    ],
    ledger_entries: [
      {
        id: "le_1",
        company_id: "co_1",
        entry_type: "top_up",
        amount_cents: 1000,
        currency: "GBP",
        balance_after_cents: 1000,
        reference_type: "stripe",
        reference_id: "pi_1",
        description: "Stripe top-up",
        metadata_json: JSON.stringify({ creditClass: "paid" }),
        created_by: "stripe-webhook",
        created_at: "2026-08-26T07:21:00.000Z",
      },
      {
        id: "le_2",
        company_id: "co_1",
        entry_type: "promotional_credit",
        amount_cents: 940,
        currency: "GBP",
        balance_after_cents: 1940,
        reference_type: "manual",
        reference_id: "manual_1",
        description: "Opening credit",
        metadata_json: JSON.stringify({ creditClass: "test" }),
        created_by: "admin@infra.test",
        created_at: "2026-08-25T10:00:00.000Z",
      },
      {
        id: "le_3",
        company_id: "co_1",
        entry_type: "usage_debit",
        amount_cents: -1,
        currency: "GBP",
        balance_after_cents: 1939,
        reference_type: "usage",
        reference_id: "usage_1",
        description: "ChatGPT · Knowledge Read",
        metadata_json: JSON.stringify({
          sourceClient: "chatgpt",
          correlationId: "corr_1",
        }),
        created_by: "daniel.dwyer123@gmail.com",
        created_at: "2026-08-25T22:35:00.000Z",
      },
    ],
  };

  prepare(sql: string) {
    return new MockStatement(this, sql);
  }

  query(sql: string, binds: unknown[]): Row[] {
    const q = sql.toLowerCase().replace(/\s+/g, " ");
    if (q.includes("from companies order by name")) {
      return this.tables.companies;
    }
    if (q.includes("from companies c") && q.includes("left join credit_balances")) {
      return this.tables.companies.map((c) => {
        const bal = this.tables.credit_balances.find((b) => b.company_id === c.id);
        return {
          ...c,
          balance_cents: bal?.balance_cents ?? 0,
          currency: bal?.currency ?? "GBP",
          low_balance_threshold_cents: bal?.low_balance_threshold_cents ?? 500,
          stripe_customer_id: null,
          updated_at: null,
          status: "active",
        };
      });
    }
    if (q.includes("from ledger_entries") && q.includes("company_id =") && q.includes("limit")) {
      return this.tables.ledger_entries
        .filter((r) => r.company_id === binds[0])
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, Number(binds[1]));
    }
    if (q.includes("sum(abs(amount_cents))") && q.includes("usage_debit")) {
      const monthStart = String(binds[1] ?? "");
      const spend = this.tables.ledger_entries
        .filter(
          (r) =>
            r.company_id === binds[0] &&
            r.entry_type === "usage_debit" &&
            Number(r.amount_cents) < 0 &&
            String(r.created_at) >= monthStart,
        )
        .reduce((sum, r) => sum + Math.abs(Number(r.amount_cents)), 0);
      return [{ spend }];
    }
    if (q.includes("sum(amount_cents)") && q.includes("amount_cents > 0")) {
      const monthStart = String(binds[1] ?? "");
      const credits = this.tables.ledger_entries
        .filter(
          (r) =>
            r.company_id === binds[0] &&
            Number(r.amount_cents) > 0 &&
            String(r.created_at) >= monthStart,
        )
        .reduce((sum, r) => sum + Number(r.amount_cents), 0);
      return [{ credits }];
    }
    if (q.includes("from ledger_entries") && q.includes("company_id =")) {
      return this.tables.ledger_entries.filter((r) => r.company_id === binds[0]);
    }
    if (q.includes("select le.* from ledger_entries")) {
      return [...this.tables.ledger_entries].sort((a, b) =>
        String(b.created_at).localeCompare(String(a.created_at)),
      );
    }
    if (q.includes("from credit_balances")) {
      return this.tables.credit_balances;
    }
    return [];
  }

  exec(_sql: string, _binds: unknown[]) {
    // no-op for tests
  }
}

describe("billing-admin", () => {
  it("classifies paid and promotional credit in enriched balances", async () => {
    const db = new MockD1() as unknown as D1Database;
    const rows = await listEnrichedPlatformBalances(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.paidCreditCents).toBe(1000);
    expect(rows[0]?.promotionalCreditCents).toBe(940);
  });

  it("builds platform ledger with source attribution", async () => {
    const db = new MockD1() as unknown as D1Database;
    const rows = await listPlatformLedger(db, { limit: 10 });
    expect(rows.length).toBeGreaterThan(0);
    const usage = rows.find((r) => r.entryType === "usage_debit");
    expect(usage?.sourceLabel).toContain("via ChatGPT");
    expect(usage?.creditClass).toBeNull();
    const promo = rows.find((r) => r.entryType === "promotional_credit");
    expect(promo?.creditClass).toBe("promotional");
  });

  it("exports ledger CSV with required columns", async () => {
    const db = new MockD1() as unknown as D1Database;
    const rows = await listPlatformLedger(db, { limit: 10 });
    const csv = platformLedgerToCsv(rows);
    expect(csv.split("\n")[0]).toContain("Timestamp");
    expect(csv).toContain("Test Co");
    expect(csv).toContain("corr_1");
  });

  it("aggregates spend this month from full ledger not paginated slice", async () => {
    const db = new MockD1() as unknown as D1Database;
    const rows = await listEnrichedPlatformBalances(db);
    expect(rows[0]?.spendThisMonthCents).toBe(1);
  });

  it("aggregates billing platform summary", async () => {
    const db = new MockD1() as unknown as D1Database;
    const summary = await getBillingPlatformSummary(db);
    expect(summary.companyCount).toBe(1);
    expect(summary.totalWalletCents).toBe(1940);
    expect(summary.totalPaidCreditCents).toBe(1000);
    expect(summary.totalPromotionalCreditCents).toBe(940);
  });
});
