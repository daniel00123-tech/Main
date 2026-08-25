import { describe, expect, it } from "vitest";
import { provisionCompany, assertCompanyAcceptsGateway } from "./tenant-provisioning";
import { validateCompanySlug } from "@infra/shared";

type Row = Record<string, unknown>;

class MockStatement {
  constructor(
    private db: FactoryD1,
    private sql: string,
    private binds: unknown[] = [],
  ) {}
  bind(...args: unknown[]) {
    return new MockStatement(this.db, this.sql, args);
  }
  async first() {
    return this.db.query(this.sql, this.binds)[0] ?? null;
  }
  async all() {
    return { results: this.db.query(this.sql, this.binds) };
  }
  async run() {
    this.db.exec(this.sql, this.binds);
    return { success: true };
  }
}

class FactoryD1 {
  tables: Record<string, Row[]> = {
    companies: [],
    credit_balances: [],
    company_commercial_settings: [],
    company_modules: [],
    ai_client_connections: [],
    ledger_entries: [],
    audit_events: [],
    users: [],
    company_memberships: [],
    password_setup_tokens: [],
    service_identities: [],
    payment_provider_accounts: [],
    mcp_environments: [],
    usage_records: [],
  };

  prepare(sql: string) {
    return new MockStatement(this, sql);
  }

  query(sql: string, binds: unknown[]): Row[] {
    const q = sql.toLowerCase().replace(/\s+/g, " ");
    if (q.includes("from companies where slug =")) {
      return this.tables.companies.filter((r) => r.slug === binds[0]);
    }
    if (q.includes("from companies where portal_subdomain =")) {
      return this.tables.companies.filter((r) => r.portal_subdomain === binds[0]);
    }
    if (q.includes("from companies where id =")) {
      return this.tables.companies.filter((r) => r.id === binds[0]);
    }
    if (q.includes("select status from companies")) {
      return this.tables.companies
        .filter((r) => r.id === binds[0])
        .map((r) => ({ status: r.status }));
    }
    if (q.includes("from credit_balances where company_id")) {
      return this.tables.credit_balances.filter((r) => r.company_id === binds[0]);
    }
    if (q.includes("sum(amount_cents)") && q.includes("ledger_entries")) {
      const total = this.tables.ledger_entries
        .filter((r) => r.company_id === binds[0])
        .reduce((sum, r) => sum + Number(r.amount_cents ?? 0), 0);
      return [{ total }];
    }
    if (q.includes("from ledger_entries") && q.includes("reference_type")) {
      return this.tables.ledger_entries.filter(
        (r) =>
          r.company_id === binds[0] &&
          r.reference_type === binds[1] &&
          r.reference_id === binds[2],
      );
    }
    return [];
  }

  exec(sql: string, binds: unknown[]) {
    const q = sql.toLowerCase().replace(/\s+/g, " ");
    if (q.startsWith("insert into companies")) {
      this.tables.companies.push({
        id: binds[0],
        slug: binds[1],
        name: binds[2],
        status: "onboarding",
        trading_name: binds[5],
        portal_subdomain: binds[14],
        portal_hostname: binds[15],
        currency: binds[17],
        created_at: binds[binds.length - 2],
        updated_at: binds[binds.length - 1],
      });
      return;
    }
    if (q.includes("update companies") && q.includes("status = 'onboarding'")) {
      const row = this.tables.companies.find((r) => r.id === binds[binds.length - 1]);
      if (row) row.status = "onboarding";
      return;
    }
    if (q.includes("insert or ignore into credit_balances") || q.includes("insert into credit_balances")) {
      if (!this.tables.credit_balances.some((r) => r.company_id === binds[0])) {
        this.tables.credit_balances.push({
          company_id: binds[0],
          balance_cents: 0,
          currency: binds[1],
        });
      }
      return;
    }
    if (q.includes("insert into company_commercial_settings")) {
      this.tables.company_commercial_settings.push({ company_id: binds[0] });
      return;
    }
    if (q.includes("insert or ignore into company_modules") || q.includes("insert into company_modules")) {
      this.tables.company_modules.push({ company_id: binds[1], module_key: binds[2] });
      return;
    }
    if (q.includes("insert or ignore into ai_client_connections") || q.includes("insert into ai_client_connections")) {
      this.tables.ai_client_connections.push({
        company_id: binds[1],
        client_type: binds[2],
      });
      return;
    }
    if (q.includes("insert into ledger_entries")) {
      this.tables.ledger_entries.push({
        company_id: binds[1],
        amount_cents: binds[3],
        entry_type: binds[2],
        metadata_json: binds[9],
      });
      const bal = this.tables.credit_balances.find((r) => r.company_id === binds[1]);
      if (bal) bal.balance_cents = binds[5];
      return;
    }
    if (q.includes("update credit_balances set balance_cents")) {
      const bal = this.tables.credit_balances.find((r) => r.company_id === binds[binds.length - 1]);
      if (bal) bal.balance_cents = binds[0];
      return;
    }
    if (q.includes("insert into audit_events")) {
      this.tables.audit_events.push({
        company_id: binds[1],
        event_type: binds[2],
      });
      return;
    }
    if (q.includes("insert or ignore into payment_provider_accounts")) {
      this.tables.payment_provider_accounts.push({
        company_id: binds[1],
        provider: binds[2],
      });
    }
  }
}

describe("generic company factory", () => {
  it("creates isolated Company A and Company B without tenant-specific code", async () => {
    const db = new FactoryD1() as unknown as D1Database;
    const a = await provisionCompany(
      db,
      { legalName: "Company A", slug: "company-a" },
      "admin@infra.test",
    );
    const b = await provisionCompany(
      db,
      { legalName: "Company B", slug: "company-b" },
      "admin@infra.test",
    );

    expect(a.company.id).not.toBe(b.company.id);
    expect(a.company.slug).toBe("company-a");
    expect(b.company.slug).toBe("company-b");
    expect(a.company.status).toBe("onboarding");
    expect(b.company.status).toBe("onboarding");

    const mock = db as unknown as FactoryD1;
    const walletA = mock.tables.credit_balances.find((r) => r.company_id === a.company.id);
    const walletB = mock.tables.credit_balances.find((r) => r.company_id === b.company.id);
    expect(walletA?.balance_cents).toBe(1000);
    expect(walletB?.balance_cents).toBe(1000);

    const aiA = mock.tables.ai_client_connections.filter((r) => r.company_id === a.company.id);
    expect(aiA.some((r) => r.client_type === "chatgpt")).toBe(true);
    expect(mock.tables.mcp_environments.filter((r) => r.company_id === a.company.id)).toHaveLength(0);

    const opening = mock.tables.ledger_entries.find((r) => r.company_id === a.company.id);
    expect(String(opening?.metadata_json)).toContain("test");

    expect(mock.tables.audit_events.some((r) => r.event_type === "company.created")).toBe(true);
    expect((await assertCompanyAcceptsGateway(db, a.company.id)).ok).toBe(true);
  });

  it("rejects reserved slugs instead of creating a platform-route tenant", async () => {
    expect(validateCompanySlug("admin").ok).toBe(false);
    const db = new FactoryD1() as unknown as D1Database;
    await expect(
      provisionCompany(db, { legalName: "Admin", slug: "admin" }, "admin@infra.test"),
    ).rejects.toThrow(/reserved/i);
  });

  it("rejects a colliding explicit slug", async () => {
    const db = new FactoryD1() as unknown as D1Database;
    await provisionCompany(db, { legalName: "Company A", slug: "company-a" }, "admin@infra.test");
    await expect(
      provisionCompany(db, { legalName: "Company A Duplicate", slug: "company-a" }, "admin@infra.test"),
    ).rejects.toThrow(/already in use/i);
  });
});
