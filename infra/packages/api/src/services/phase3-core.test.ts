import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  appendLedgerEntry,
  getWalletBalance,
} from "./ledger";
import { calculateChargeCents } from "./pricing";
import {
  generateServiceToken,
  hashServiceToken,
  serviceHasActionScope,
} from "./service-identities";
import { validateRegisteredMcpEndpoint } from "./control-plane";

type Row = Record<string, unknown>;

class MockD1 {
  tables = new Map<string, Row[]>();

  constructor(initial: Record<string, Row[]> = {}) {
    for (const [table, rows] of Object.entries(initial)) {
      this.tables.set(table, rows.map((row) => ({ ...row })));
    }
  }

  prepare(query: string) {
    return new MockStatement(query, this.tables);
  }
}

class MockStatement {
  private binds: unknown[] = [];

  constructor(
    private query: string,
    private tables: Map<string, Row[]>,
  ) {}

  bind(...values: unknown[]) {
    this.binds = values;
    return this;
  }

  async first(): Promise<Row | null> {
    return this.execute()[0] ?? null;
  }

  async all(): Promise<{ results: Row[] }> {
    return { results: this.execute() };
  }

  async run(): Promise<{ success: boolean }> {
    this.executeMutation();
    return { success: true };
  }

  private table(name: string): Row[] {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name)!;
  }

  private execute(): Row[] {
    const q = this.query.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.includes("from credit_balances")) {
      return this.table("credit_balances").filter(
        (row) => row.company_id === this.binds[0],
      );
    }
    if (q.includes("sum(amount_cents)") && q.includes("ledger_entries")) {
      const rows = this.table("ledger_entries").filter(
        (row) => row.company_id === this.binds[0],
      );
      const total = rows.reduce((sum, row) => sum + Number(row.amount_cents), 0);
      return [{ total }];
    }
    if (
      q.includes("from ledger_entries") &&
      q.includes("reference_type") &&
      q.includes("reference_id")
    ) {
      return this.table("ledger_entries").filter(
        (row) =>
          row.company_id === this.binds[0] &&
          row.reference_type === this.binds[1] &&
          row.reference_id === this.binds[2],
      );
    }
    if (q.includes("from ledger_entries") && q.includes("order by created_at")) {
      return this.table("ledger_entries")
        .filter((row) => row.company_id === this.binds[0])
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    }
    return [];
  }

  private executeMutation() {
    const q = this.query.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.startsWith("insert or ignore into credit_balances")) {
      if (
        !this.table("credit_balances").some(
          (row) => row.company_id === this.binds[0],
        )
      ) {
        this.table("credit_balances").push({
          company_id: this.binds[0],
          balance_cents: 0,
          currency: this.binds[1],
          updated_at: this.binds[2],
          low_balance_threshold_cents: 500,
        });
      }
    }
    if (q.startsWith("insert into ledger_entries")) {
      this.table("ledger_entries").push({
        id: this.binds[0],
        company_id: this.binds[1],
        entry_type: this.binds[2],
        amount_cents: this.binds[3],
        currency: this.binds[4],
        balance_after_cents: this.binds[5],
        reference_type: this.binds[6],
        reference_id: this.binds[7],
        description: this.binds[8],
        metadata_json: this.binds[9],
        created_by: this.binds[10],
        created_at: this.binds[11],
      });
    }
    if (q.startsWith("update credit_balances")) {
      const row = this.table("credit_balances").find(
        (item) => item.company_id === this.binds[this.binds.length - 1],
      );
      if (row) {
        row.balance_cents = this.binds[0];
        row.updated_at = this.binds[1];
      }
    }
  }
}

describe("wallet ledger", () => {
  it("derives balance from ledger entries and is idempotent on reference", async () => {
    const db = new MockD1({
      credit_balances: [],
      ledger_entries: [],
    });

    await appendLedgerEntry(db as unknown as D1Database, {
      companyId: "co_caddington",
      entryType: "promotional_credit",
      amountCents: 1000,
      referenceType: "seed",
      referenceId: "opening",
    });

    await appendLedgerEntry(db as unknown as D1Database, {
      companyId: "co_caddington",
      entryType: "usage_debit",
      amountCents: -1,
      referenceType: "usage",
      referenceId: "usage_1",
    });

    // Duplicate debit with same reference must not double-charge
    const dup = await appendLedgerEntry(db as unknown as D1Database, {
      companyId: "co_caddington",
      entryType: "usage_debit",
      amountCents: -1,
      referenceType: "usage",
      referenceId: "usage_1",
    });
    expect(dup.alreadyExists).toBe(true);

    const wallet = await getWalletBalance(
      db as unknown as D1Database,
      "co_caddington",
    );
    expect(wallet.balanceCents).toBe(999);
  });

  it("rejects usage debits that would take the ledger below zero", async () => {
    const db = new MockD1({
      credit_balances: [],
      ledger_entries: [],
    });

    await appendLedgerEntry(db as unknown as D1Database, {
      companyId: "co_ht",
      entryType: "promotional_credit",
      amountCents: 1,
      referenceType: "seed",
      referenceId: "tiny",
    });

    await expect(
      appendLedgerEntry(db as unknown as D1Database, {
        companyId: "co_ht",
        entryType: "usage_debit",
        amountCents: -2,
        referenceType: "usage",
        referenceId: "usage_overdraw",
      }),
    ).rejects.toThrow("INSUFFICIENT_CREDIT");

    const wallet = await getWalletBalance(db as unknown as D1Database, "co_ht");
    expect(wallet.balanceCents).toBe(1);
  });
});

describe("pricing", () => {
  it("does not charge failed requests by default", () => {
    const result = calculateChargeCents(
      {
        id: "p1",
        companyId: null,
        action: "knowledge.search",
        pricingMode: "fixed",
        fixedChargeCents: 1,
        markupPercent: null,
        targetMarginBps: 6000,
        minimumChargeCents: 0,
        chargeOnFailure: false,
        isBillable: true,
        label: "TEST",
        isTestConfig: true,
        enabled: true,
        rateCardId: null,
        versionLabel: null,
        effectiveFrom: null,
        effectiveTo: null,
        marginBasis: "gross_margin",
        costCategory: null,
      },
      { success: false },
    );
    expect(result.billable).toBe(false);
    expect(result.customerChargeCents).toBeNull();
  });

  it("charges fixed amount on success", () => {
    const result = calculateChargeCents(
      {
        id: "p1",
        companyId: null,
        action: "knowledge.search",
        pricingMode: "fixed",
        fixedChargeCents: 1,
        markupPercent: null,
        targetMarginBps: 6000,
        minimumChargeCents: 0,
        chargeOnFailure: false,
        isBillable: true,
        label: "TEST",
        isTestConfig: true,
        enabled: true,
        rateCardId: null,
        versionLabel: null,
        effectiveFrom: null,
        effectiveTo: null,
        marginBasis: "gross_margin",
        costCategory: null,
      },
      { success: true },
    );
    expect(result.customerChargeCents).toBe(1);
    expect(result.isTestConfig).toBe(true);
  });
});

describe("service identity tokens", () => {
  it("hashes tokens and never compares plaintext", async () => {
    const generated = await generateServiceToken();
    expect(generated.token.startsWith("infra_")).toBe(true);
    expect(await hashServiceToken(generated.token)).toBe(generated.hash);
    expect(generated.hash).not.toContain(generated.token);
  });

  it("enforces scopes", () => {
    const identity = {
      id: "svc_1",
      companyId: "co_caddington",
      name: "ChatGPT",
      description: null,
      identityType: "chatgpt" as const,
      status: "active" as const,
      tokenPrefix: "infra_abc",
      hasToken: true,
      scopes: ["knowledge.search"],
      mcpEnvironmentId: "mcp_caddington_primary",
      lastUsedAt: null,
      requestCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    expect(serviceHasActionScope(identity, "knowledge.search")).toBe(true);
    expect(serviceHasActionScope(identity, "bigchange.invoices.create")).toBe(
      false,
    );
  });
});

describe("MCP endpoint injection / SSRF", () => {
  it("blocks private and localhost MCP URLs", () => {
    expect(
      validateRegisteredMcpEndpoint("http://127.0.0.1/mcp", "production").valid,
    ).toBe(false);
    expect(
      validateRegisteredMcpEndpoint("https://169.254.169.254/", "production")
        .valid,
    ).toBe(false);
  });
});
