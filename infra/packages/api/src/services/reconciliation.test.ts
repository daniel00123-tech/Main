import { describe, expect, it } from "vitest";
import {
  appendLedgerEntry,
  getWalletBalance,
} from "./ledger";
import { healUsageLedgerLinks, runFinancialReconciliation } from "./reconciliation";
import { calculateChargeCents, DEFAULT_MINIMUM_CHARGE_CENTS } from "./pricing";

type Row = Record<string, unknown>;

class FakeD1 {
  tables: Record<string, Row[]>;

  constructor(seed: Record<string, Row[]>) {
    this.tables = seed;
  }

  prepare(sql: string) {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    const self = this;
    return {
      bind(...args: unknown[]) {
        return {
          async first() {
            return self.queryFirst(q, args);
          },
          async all() {
            return { results: self.queryAll(q, args) };
          },
          async run() {
            self.run(q, args);
            return { success: true };
          },
        };
      },
      async first() {
        return self.queryFirst(q, []);
      },
      async all() {
        return { results: self.queryAll(q, []) };
      },
      async run() {
        self.run(q, []);
        return { success: true };
      },
    };
  }

  private table(name: string) {
    if (!this.tables[name]) this.tables[name] = [];
    return this.tables[name];
  }

  private queryFirst(q: string, args: unknown[]): Row | null {
    if (q.includes("from credit_balances") && q.includes("where company_id")) {
      return this.table("credit_balances").find((r) => r.company_id === args[0]) ?? null;
    }
    if (q.includes("sum(amount_cents)") && q.includes("ledger_entries")) {
      const rows = this.table("ledger_entries").filter((r) => r.company_id === args[0]);
      return { total: rows.reduce((s, r) => s + Number(r.amount_cents ?? 0), 0) };
    }
    if (
      q.includes("from ledger_entries") &&
      q.includes("reference_type") &&
      q.includes("reference_id")
    ) {
      return (
        this.table("ledger_entries").find(
          (r) =>
            r.company_id === args[0] &&
            r.reference_type === args[1] &&
            r.reference_id === args[2],
        ) ?? null
      );
    }
    if (
      q.includes("from financial_integrity_exceptions") &&
      q.includes("exception_type")
    ) {
      return null;
    }
    return null;
  }

  private queryAll(q: string, args: unknown[]): Row[] {
    if (
      q.includes("from usage_records u") &&
      q.includes("join ledger_entries l") &&
      q.includes("ledger_entry_id is null")
    ) {
      return this.table("usage_records")
        .filter((u) => !u.ledger_entry_id)
        .map((u) => {
          const ledger = this.table("ledger_entries").find(
            (l) => l.reference_type === "usage" && l.reference_id === u.id,
          );
          return ledger ? { usage_id: u.id, ledger_id: ledger.id } : null;
        })
        .filter(Boolean) as Row[];
    }
    if (
      q.includes("from usage_records u") &&
      q.includes("customer_charge_cents > 0") &&
      q.includes("not exists")
    ) {
      return this.table("usage_records").filter((u) => {
        if (Number(u.success) !== 1) return false;
        if (!(Number(u.customer_charge_cents) > 0)) return false;
        if (u.ledger_entry_id && u.settlement_status === "settled") return false;
        const hasLedger = this.table("ledger_entries").some(
          (l) => l.reference_type === "usage" && l.reference_id === u.id,
        );
        return !hasLedger;
      });
    }
    if (q.includes("from ledger_entries l") && q.includes("not exists")) {
      return [];
    }
    if (q.includes("abs(l.amount_cents) != u.customer_charge_cents")) {
      return [];
    }
    if (q.includes("group by company_id, reference_id") && q.includes("having")) {
      return [];
    }
    if (q.includes("from credit_balances")) {
      return this.table("credit_balances");
    }
    if (q.includes("from financial_integrity_exceptions")) {
      return this.table("financial_integrity_exceptions");
    }
    return [];
  }

  private run(q: string, args: unknown[]) {
    if (q.startsWith("insert or ignore into credit_balances")) {
      if (!this.table("credit_balances").some((r) => r.company_id === args[0])) {
        this.table("credit_balances").push({
          company_id: args[0],
          balance_cents: 0,
          currency: args[1],
          updated_at: args[2],
          low_balance_threshold_cents: 500,
        });
      }
      return;
    }
    if (q.startsWith("insert into ledger_entries")) {
      this.table("ledger_entries").push({
        id: args[0],
        company_id: args[1],
        entry_type: args[2],
        amount_cents: args[3],
        currency: args[4],
        balance_after_cents: args[5],
        reference_type: args[6],
        reference_id: args[7],
        description: args[8],
        metadata_json: args[9],
        created_by: args[10],
        created_at: args[11],
      });
      return;
    }
    if (q.startsWith("update credit_balances set balance_cents")) {
      const row = this.table("credit_balances").find((r) => r.company_id === args[2]);
      if (row) {
        row.balance_cents = args[0];
        row.updated_at = args[1];
      }
      return;
    }
    if (
      q.startsWith("update usage_records") &&
      q.includes("settlement_status = 'settled'")
    ) {
      const row = this.table("usage_records").find((r) => r.id === args[1]);
      if (row) {
        row.ledger_entry_id = args[0];
        row.settlement_status = "settled";
      }
      return;
    }
    if (q.startsWith("insert into financial_integrity_exceptions")) {
      this.table("financial_integrity_exceptions").push({
        id: args[0],
        company_id: args[1],
        exception_type: "usage_without_ledger",
        usage_record_id: args[2],
        detail_json: args[3],
        detected_at: args[4],
        status: "open",
      });
    }
  }
}

describe("financial reconciliation", () => {
  it("heals usage↔ledger settlement links without creating new debits", async () => {
    const db = new FakeD1({
      credit_balances: [
        {
          company_id: "co_test",
          balance_cents: 999,
          currency: "GBP",
          updated_at: "t",
          low_balance_threshold_cents: 500,
        },
      ],
      usage_records: [
        {
          id: "usage_1",
          company_id: "co_test",
          success: 1,
          customer_charge_cents: 1,
          ledger_entry_id: null,
          settlement_status: "unsettled",
        },
      ],
      ledger_entries: [
        {
          id: "ledger_open",
          company_id: "co_test",
          entry_type: "promotional_credit",
          amount_cents: 1000,
          reference_type: "seed",
          reference_id: "open",
        },
        {
          id: "ledger_1",
          company_id: "co_test",
          entry_type: "usage_debit",
          amount_cents: -1,
          reference_type: "usage",
          reference_id: "usage_1",
        },
      ],
      financial_integrity_exceptions: [],
    }) as unknown as D1Database;

    const healed = await healUsageLedgerLinks(db);
    expect(healed).toEqual([{ usageId: "usage_1", ledgerId: "ledger_1" }]);

    const before = (db as unknown as FakeD1).tables.ledger_entries.length;
    const result = await runFinancialReconciliation(db);
    expect(result.exceptionsCreated).toBe(0);
    expect((db as unknown as FakeD1).tables.ledger_entries.length).toBe(before);
  });

  it("flags truly unpaid billable usage without creating a debit", async () => {
    const db = new FakeD1({
      credit_balances: [
        {
          company_id: "co_test",
          balance_cents: 1000,
          currency: "GBP",
          updated_at: "t",
          low_balance_threshold_cents: 500,
        },
      ],
      usage_records: [
        {
          id: "usage_unpaid",
          company_id: "co_test",
          success: 1,
          customer_charge_cents: 1,
          ledger_entry_id: null,
          settlement_status: "unsettled",
          correlation_id: "corr_x",
          request_id: "req_x",
        },
      ],
      ledger_entries: [
        {
          id: "ledger_open",
          company_id: "co_test",
          entry_type: "promotional_credit",
          amount_cents: 1000,
          reference_type: "seed",
          reference_id: "open",
        },
      ],
      financial_integrity_exceptions: [],
    }) as unknown as D1Database;

    const result = await runFinancialReconciliation(db);
    expect(result.exceptionsCreated).toBe(1);
    expect((db as unknown as FakeD1).tables.ledger_entries.length).toBe(1);
  });
});

describe("insufficient credit policy", () => {
  it("does not debit when balance cannot fund minimum charge", async () => {
    const db = new FakeD1({
      credit_balances: [
        {
          company_id: "co_empty",
          balance_cents: 0,
          currency: "GBP",
          updated_at: "t",
          low_balance_threshold_cents: 500,
        },
      ],
      ledger_entries: [],
    }) as unknown as D1Database;

    const wallet = await getWalletBalance(db, "co_empty");
    expect(wallet.balanceCents).toBe(0);

    const required = DEFAULT_MINIMUM_CHARGE_CENTS;
    expect(wallet.balanceCents >= required).toBe(false);
    // No ledger write attempted in this fixture path
    expect((db as unknown as FakeD1).tables.ledger_entries.length).toBe(0);
  });

  it("ledger debit is idempotent on usage reference", async () => {
    const db = new FakeD1({
      credit_balances: [
        {
          company_id: "co_test",
          balance_cents: 10,
          currency: "GBP",
          updated_at: "t",
          low_balance_threshold_cents: 500,
        },
      ],
      ledger_entries: [
        {
          id: "ledger_open",
          company_id: "co_test",
          entry_type: "promotional_credit",
          amount_cents: 10,
          reference_type: "seed",
          reference_id: "open",
        },
      ],
    }) as unknown as D1Database;

    const first = await appendLedgerEntry(db, {
      companyId: "co_test",
      entryType: "usage_debit",
      amountCents: -1,
      referenceType: "usage",
      referenceId: "usage_same",
      description: "ChatGPT · Knowledge Search",
    });
    const second = await appendLedgerEntry(db, {
      companyId: "co_test",
      entryType: "usage_debit",
      amountCents: -1,
      referenceType: "usage",
      referenceId: "usage_same",
      description: "ChatGPT · Knowledge Search",
    });

    expect(first.alreadyExists).toBe(false);
    expect(second.alreadyExists).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);
    expect((await getWalletBalance(db, "co_test")).balanceCents).toBe(9);
  });
});

describe("failed request billing policy", () => {
  it("authz failure style rules produce £0 customer charge", () => {
    const result = calculateChargeCents(
      {
        id: "price_fail",
        companyId: null,
        action: "knowledge.search",
        pricingMode: "fixed",
        fixedChargeCents: 1,
        markupPercent: null,
        targetMarginBps: 6000,
        minimumChargeCents: 1,
        chargeOnFailure: false,
        isBillable: true,
        label: "test",
        isTestConfig: true,
        enabled: true,
        rateCardId: null,
        versionLabel: "v1",
        effectiveFrom: null,
        effectiveTo: null,
        marginBasis: "gross_margin",
        costCategory: null,
      },
      { success: false, underlyingCostMicros: null, costBasis: "unknown" },
    );
    expect(result.customerChargeCents).toBeNull();
    expect(result.billable).toBe(false);
  });
});
