import { describe, expect, it } from "vitest";
import {
  portalHostnameFor,
  provisionCompany,
  setCompanyLifecycleStatus,
  slugifyCompanyName,
  assertCompanyAcceptsGateway,
} from "./tenant-provisioning";

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
    if (q.includes("from users where email")) {
      return this.tables.users.filter(
        (r) => String(r.email).toLowerCase() === String(binds[0]).toLowerCase(),
      );
    }
    if (q.includes("from company_memberships where user_id") && q.includes("company_id")) {
      return this.tables.company_memberships.filter(
        (r) => r.user_id === binds[0] && r.company_id === binds[1],
      );
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
    if (q.includes("from ai_client_connections where company_id") && q.includes("client_type")) {
      return this.tables.ai_client_connections.filter(
        (r) => r.company_id === binds[0] && r.client_type === binds[1],
      );
    }
    return [];
  }

  exec(sql: string, binds: unknown[]) {
    const q = sql.toLowerCase().replace(/\s+/g, " ");
    if (q.startsWith("insert into companies") || q.startsWith("insert into companies (")) {
      this.tables.companies.push({
        id: binds[0],
        slug: binds[1],
        name: binds[2],
        status: "onboarding",
        primary_domain: binds[3],
        notes: binds[4],
        trading_name: binds[5],
        company_number: binds[6],
        country: binds[7],
        timezone: binds[8],
        primary_contact_name: binds[9],
        primary_email: binds[10],
        billing_email: binds[11],
        telephone: binds[12],
        logo_url: binds[13],
        portal_subdomain: binds[14],
        portal_hostname: binds[15],
        provisioned_at: binds[16],
        created_at: binds[17],
        updated_at: binds[18],
      });
      return;
    }
    if (q.includes("update companies") && q.includes("status = 'onboarding'")) {
      const row = this.tables.companies.find((r) => r.id === binds[binds.length - 1]);
      if (row) {
        row.status = "onboarding";
        row.primary_admin_user_id = binds[0];
        row.updated_at = binds[1];
      }
      return;
    }
    if (q.includes("update companies set status = 'active'")) {
      const row = this.tables.companies.find((r) => r.id === binds[1]);
      if (row) {
        row.status = "active";
        row.updated_at = binds[0];
      }
      return;
    }
    if (q.includes("update companies set status = 'suspended'")) {
      const row = this.tables.companies.find((r) => r.id === binds[2]);
      if (row) {
        row.status = "suspended";
        row.suspended_at = binds[0];
        row.updated_at = binds[1];
      }
      return;
    }
    if (q.includes("insert into credit_balances") || q.includes("insert or ignore into credit_balances")) {
      if (!this.tables.credit_balances.some((r) => r.company_id === binds[0])) {
        this.tables.credit_balances.push({
          company_id: binds[0],
          balance_cents: 0,
          currency: binds[1],
          low_balance_threshold_cents: 500,
          updated_at: binds[2] ?? binds[1],
        });
      }
      return;
    }
    if (q.includes("insert into company_commercial_settings")) {
      this.tables.company_commercial_settings.push({
        company_id: binds[0],
        currency: binds[1],
        included_credit_cents: binds[2],
        updated_at: binds[3],
      });
      return;
    }
    if (q.includes("insert or ignore into company_modules") || q.includes("insert into company_modules")) {
      this.tables.company_modules.push({
        id: binds[0],
        company_id: binds[1],
        module_key: binds[2],
        status: binds[3],
      });
      return;
    }
    if (q.includes("insert or ignore into ai_client_connections") || q.includes("insert into ai_client_connections")) {
      const companyId = binds[1];
      const clientType = binds[2];
      if (
        !this.tables.ai_client_connections.some(
          (r) => r.company_id === companyId && r.client_type === clientType,
        )
      ) {
        this.tables.ai_client_connections.push({
          id: binds[0],
          company_id: companyId,
          client_type: clientType,
          display_name: binds[3],
          status: binds[4],
        });
      }
      return;
    }
    if (q.includes("insert into ledger_entries")) {
      this.tables.ledger_entries.push({
        id: binds[0],
        company_id: binds[1],
        entry_type: binds[2],
        amount_cents: binds[3],
        currency: binds[4],
        balance_after_cents: binds[5],
        reference_type: binds[6],
        reference_id: binds[7],
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
        id: binds[0],
        company_id: binds[1],
        event_type: binds[2],
      });
      return;
    }
    if (q.includes("update service_identities set status = 'disabled'")) {
      for (const row of this.tables.service_identities) {
        if (row.company_id === binds[1] || row.company_id === binds[binds.length - 1]) {
          row.status = "disabled";
        }
      }
    }
  }
}

describe("tenant provisioning", () => {
  it("slugifies company names", () => {
    expect(slugifyCompanyName("Caddington Holdings")).toBe("caddington-holdings");
    expect(slugifyCompanyName("Heat Tech / HT")).toBe("heat-tech-ht");
  });

  it("builds portal hostnames", () => {
    expect(portalHostnameFor("caddington")).toBe("caddington.infra-web.pages.dev");
  });

  it("provisions isolated tenants with wallets and AI shells", async () => {
    const db = new MockD1() as unknown as D1Database;
    const a = await provisionCompany(
      db,
      {
        legalName: "Caddington Holdings",
        tradingName: "Caddington",
        portalSubdomain: "caddington",
        openingCreditCents: 1000,
        primaryEmail: "ops@caddington.test",
      },
      "admin@infra.test",
    );
    const b = await provisionCompany(
      db,
      {
        legalName: "INFRA Test Company",
        portalSubdomain: "infra-test",
        openingCreditCents: 500,
      },
      "admin@infra.test",
    );

    expect(a.company.id).not.toBe(b.company.id);
    expect(a.company.slug).not.toBe(b.company.slug);
    expect(a.company.portalSubdomain).toBe("caddington");
    expect(b.company.portalSubdomain).toBe("infra-test");
    expect(a.company.status).toBe("onboarding");

    const mock = db as unknown as MockD1;
    const walletsA = mock.tables.credit_balances.filter(
      (r) => r.company_id === a.company.id,
    );
    const walletsB = mock.tables.credit_balances.filter(
      (r) => r.company_id === b.company.id,
    );
    expect(walletsA).toHaveLength(1);
    expect(walletsB).toHaveLength(1);
    expect(walletsA[0].balance_cents).toBe(1000);
    expect(walletsB[0].balance_cents).toBe(500);

    const aiA = mock.tables.ai_client_connections.filter(
      (r) => r.company_id === a.company.id,
    );
    const aiB = mock.tables.ai_client_connections.filter(
      (r) => r.company_id === b.company.id,
    );
    expect(aiA.some((r) => r.client_type === "chatgpt")).toBe(true);
    expect(aiB.some((r) => r.client_type === "chatgpt")).toBe(true);
  });

  it("blocks gateway for suspended companies", async () => {
    const db = new MockD1() as unknown as D1Database;
    const created = await provisionCompany(
      db,
      { legalName: "Suspend Me", portalSubdomain: "suspendme" },
      "admin@infra.test",
    );
    expect((await assertCompanyAcceptsGateway(db, created.company.id)).ok).toBe(true);
    await setCompanyLifecycleStatus(db, created.company.id, "suspended", "admin@infra.test");
    const blocked = await assertCompanyAcceptsGateway(db, created.company.id);
    expect(blocked.ok).toBe(false);
  });
});
