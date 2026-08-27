import { describe, expect, it, vi, beforeEach } from "vitest";
import { settleActionExecutionUsage } from "./action-settlement";

type Row = Record<string, unknown>;

class FakeStatement {
  constructor(
    private db: FakeD1,
    private sql: string,
    private binds: unknown[] = [],
  ) {}

  bind(...args: unknown[]) {
    return new FakeStatement(this.db, this.sql, args);
  }

  async first() {
    return this.db.first(this.sql, this.binds);
  }

  async all() {
    return { results: this.db.all(this.sql, this.binds) };
  }

  async run() {
    this.db.run(this.sql, this.binds);
    return { success: true, meta: { last_row_id: 1 } };
  }
}

class FakeD1 {
  tables: Record<string, Row[]> = {
    pricing_rules: [
      {
        id: "price_xero_invoice_create",
        company_id: null,
        action: "xero.invoices.create",
        pricing_mode: "fixed",
        fixed_charge_cents: 1,
        markup_percent: null,
        minimum_charge_cents: 1,
        charge_on_failure: 0,
        is_billable: 1,
        label: "TEST",
        is_test_config: 1,
        enabled: 1,
        target_margin_bps: 6000,
        version_label: "v1",
        effective_from: "2026-01-01",
        effective_to: null,
        margin_basis: "gross_margin",
        rate_card_id: null,
        cost_category: null,
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    ],
    pricing_policies: [
      {
        id: "policy_platform_default",
        company_id: null,
        target_margin_bps: 6000,
        minimum_charge_cents: 1,
        currency: "GBP",
        is_test_config: 1,
        enabled: 1,
        label: "default",
        effective_from: "2026-01-01",
        effective_to: null,
        margin_basis: "gross_margin",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    ],
    credit_balances: [{ company_id: "co_test", balance_cents: 100, currency: "GBP", updated_at: "2026-01-01" }],
    usage_records: [],
    ledger_entries: [],
    audit_events: [],
    promotional_grants: [],
  };

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  first(sql: string, binds: unknown[]): Row | null {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.includes("from usage_records where request_id")) {
      return this.tables.usage_records.find((r) => r.request_id === binds[0]) ?? null;
    }
    if (q.includes("from usage_records where correlation_id")) {
      return this.tables.usage_records.find((r) => r.correlation_id === binds[0]) ?? null;
    }
    if (q.includes("from pricing_rules")) {
      const action = binds.length >= 2 ? binds[1] : binds[0];
      return (
        this.tables.pricing_rules.find((r) => r.action === action) ??
        this.tables.pricing_rules.find((r) => r.action === binds[0]) ??
        this.tables.pricing_rules[0] ??
        null
      );
    }
    if (q.includes("from credit_balances")) {
      return this.tables.credit_balances.find((r) => r.company_id === binds[0]) ?? null;
    }
    if (q.includes("from promotional_grants")) {
      return null;
    }
    return null;
  }

  all(sql: string, _binds: unknown[]): Row[] {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.includes("from pricing_rules")) return this.tables.pricing_rules;
    if (q.includes("from pricing_policies")) return this.tables.pricing_policies;
    return [];
  }

  run(sql: string, binds: unknown[]) {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.startsWith("insert into usage_records")) {
      this.tables.usage_records.push({
        id: String(binds[0]),
        company_id: binds[1],
        request_id: binds[21],
        correlation_id: binds[18],
        customer_charge_cents: binds[20],
        settlement_status: binds[34],
        ledger_entry_id: binds[33],
      });
    }
    if (q.startsWith("insert into ledger_entries")) {
      this.tables.ledger_entries.push({
        id: String(binds[0]),
        company_id: binds[1],
        amount_cents: binds[3],
        balance_after_cents: 99,
      });
      const bal = this.tables.credit_balances.find((r) => r.company_id === binds[1]);
      if (bal) bal.balance_cents = 99;
    }
    if (q.includes("update usage_records set settlement_status")) {
      const usage = this.tables.usage_records.find((r) => r.id === binds[2]);
      if (usage) {
        usage.settlement_status = "settled";
        usage.ledger_entry_id = binds[1];
      }
    }
  }
}

describe("action-settlement", () => {
  it("uses execution id directly as request id without double aex_ prefix", async () => {
    const db = new FakeD1();
    const executionId = "aex_test-uuid";
    await settleActionExecutionUsage({ DB: db as unknown as D1Database } as never, {
      companyId: "co_test",
      action: "xero.invoices.create",
      actor: "test@test.com",
      executionId,
      planId: "act_1",
      success: true,
    });
    const usage = db.tables.usage_records[0];
    expect(usage?.request_id).toBe(executionId);
    expect(String(usage?.request_id)).not.toMatch(/^aex_aex_/);
  });

  it("idempotent replay does not create duplicate usage rows", async () => {
    const db = new FakeD1();
    const executionId = "aex_replay-test";
    const env = { DB: db as unknown as D1Database } as never;
    await settleActionExecutionUsage(env, {
      companyId: "co_test",
      action: "xero.invoices.create",
      actor: "test@test.com",
      executionId,
      planId: "act_1",
      success: true,
    });
    await settleActionExecutionUsage(env, {
      companyId: "co_test",
      action: "xero.invoices.create",
      actor: "test@test.com",
      executionId,
      planId: "act_1",
      success: true,
    });
    expect(db.tables.usage_records.length).toBe(1);
  });
});
