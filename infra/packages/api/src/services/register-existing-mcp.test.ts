import { describe, expect, it } from "vitest";
import {
  EXISTING_PRODUCTION_COMPANY_MCPS,
  attachExistingCompanyMcp,
  registerExistingMcpEnvironment,
} from "./register-existing-mcp";

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
    return { success: true };
  }
}

class FakeD1 {
  tables: Record<string, Row[]> = {
    companies: [],
    credit_balances: [],
    company_commercial_settings: [],
    company_modules: [],
    ai_client_connections: [],
    ledger_entries: [],
    audit_events: [],
    company_memberships: [],
    mcp_environments: [],
    connector_instances: [],
  };

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  first(sql: string, binds: unknown[]): Row | null {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.includes("from companies where id = ? or slug = ?")) {
      return (
        this.tables.companies.find(
          (r) => r.id === binds[0] || r.slug === binds[1],
        ) ?? null
      );
    }
    if (q.includes("from companies where id = ?") && !q.includes("slug")) {
      return this.tables.companies.find((r) => r.id === binds[0]) ?? null;
    }
    if (q.includes("from companies where slug = ?")) {
      return this.tables.companies.find((r) => r.slug === binds[0]) ?? null;
    }
    if (q.includes("from companies where portal_subdomain = ?")) {
      return (
        this.tables.companies.find((r) => r.portal_subdomain === binds[0]) ??
        null
      );
    }
    if (q.includes("from mcp_environments where lower(endpoint_url)")) {
      return (
        this.tables.mcp_environments.find(
          (r) => String(r.endpoint_url).toLowerCase() === String(binds[0]).toLowerCase(),
        ) ?? null
      );
    }
    if (q.includes("from mcp_environments where id = ?")) {
      return this.tables.mcp_environments.find((r) => r.id === binds[0]) ?? null;
    }
    if (q.includes("from connector_instances") && q.includes("connector_definition_id")) {
      return (
        this.tables.connector_instances.find(
          (r) =>
            r.company_id === binds[0] && r.connector_definition_id === binds[1],
        ) ?? null
      );
    }
    if (q.includes("from ledger_entries") && q.includes("reference_id")) {
      return (
        this.tables.ledger_entries.find(
          (r) =>
            r.company_id === binds[0] &&
            r.reference_type === binds[1] &&
            r.reference_id === binds[2],
        ) ?? null
      );
    }
    if (q.includes("sum(amount_cents)")) {
      const total = this.tables.ledger_entries
        .filter((r) => r.company_id === binds[0])
        .reduce((s, r) => s + Number(r.amount_cents ?? 0), 0);
      return { total };
    }
    if (q.includes("from credit_balances")) {
      return (
        this.tables.credit_balances.find((r) => r.company_id === binds[0]) ?? null
      );
    }
    return null;
  }

  all(_sql?: string, _binds?: unknown[]): Row[] {
    return [];
  }

  run(sql: string, binds: unknown[]) {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.startsWith("insert into companies")) {
      this.tables.companies.push({
        id: binds[0],
        slug: binds[1],
        name: binds[2],
        status: "provisioning",
        trading_name: binds[5],
        portal_subdomain: binds[14],
        portal_hostname: binds[15],
        created_at: binds[17],
        updated_at: binds[18],
      });
    }
    if (q.startsWith("insert into credit_balances")) {
      this.tables.credit_balances.push({
        company_id: binds[0],
        balance_cents: binds[1],
        currency: binds[2],
      });
    }
    if (q.startsWith("insert into company_commercial_settings")) {
      this.tables.company_commercial_settings.push({ company_id: binds[0] });
    }
    if (q.startsWith("insert or ignore into company_modules")) {
      this.tables.company_modules.push({
        company_id: binds[1],
        module_key: binds[2],
      });
    }
    if (q.startsWith("insert or ignore into ai_client_connections")) {
      this.tables.ai_client_connections.push({
        company_id: binds[1],
        client_type: binds[2],
      });
    }
    if (q.startsWith("insert into ledger_entries")) {
      this.tables.ledger_entries.push({
        id: binds[0],
        company_id: binds[1],
        amount_cents: binds[3],
        reference_type: binds[6],
        reference_id: binds[7],
      });
    }
    if (q.startsWith("update credit_balances set balance_cents")) {
      const row = this.tables.credit_balances.find((r) => r.company_id === binds[2]);
      if (row) row.balance_cents = binds[0];
    }
    if (q.startsWith("update companies set status = 'active'")) {
      const row = this.tables.companies.find((r) => r.id === binds[1]);
      if (row) row.status = "active";
    }
    if (q.startsWith("insert into audit_events")) {
      this.tables.audit_events.push({ id: binds[0], company_id: binds[1] });
    }
    if (q.startsWith("insert into mcp_environments")) {
      this.tables.mcp_environments.push({
        id: binds[0],
        company_id: binds[1],
        name: binds[2],
        endpoint_url: binds[4],
        capabilities_json: binds[8],
        auth_secret_ref: binds[9],
        service_binding_ref: binds[10],
        status: "registered",
        enabled: 1,
        is_external: 1,
      });
    }
    if (q.startsWith("insert into connector_instances")) {
      this.tables.connector_instances.push({
        id: binds[0],
        company_id: binds[1],
        connector_definition_id: binds[2],
        name: binds[3],
        status: "draft",
      });
    }
    if (q.startsWith("update companies set id = ?")) {
      const row = this.tables.companies.find((r) => r.id === binds[1]);
      if (row) row.id = binds[0];
    }
    if (q.includes("set company_id = ? where company_id = ?")) {
      const table = q.split("update ")[1]?.split(" set")[0];
      if (table && this.tables[table]) {
        for (const row of this.tables[table]) {
          if (row.company_id === binds[1]) row.company_id = binds[0];
        }
      }
    }
  }
}

describe("register existing company MCP", () => {
  it("documents HT and EL as existing Workers, not replacements", () => {
    const ht = EXISTING_PRODUCTION_COMPANY_MCPS.find((s) => s.slug === "ht-business");
    const el = EXISTING_PRODUCTION_COMPANY_MCPS.find((s) => s.slug === "el-business");
    expect(ht?.mcp.endpointUrl).toContain("ht-business-mcp");
    expect(el?.mcp.endpointUrl).toContain("el-business-mcp");
    expect(ht?.mcp.authSecretRef).toBe("HT_MCP_AUTH_TOKEN");
    expect(el?.mcp.authSecretRef).toBe("EL_MCP_AUTH_TOKEN");
    expect(ht?.mcp.knowledgeStatus).toBe("not_configured");
    expect(el?.mcp.knowledgeStatus).toBe("not_configured");
  });

  it("refuses to register one company's MCP endpoint onto another", async () => {
    const db = new FakeD1();
    db.tables.mcp_environments.push({
      id: "mcp_ht_primary",
      company_id: "co_ht",
      endpoint_url: "https://ht-business-mcp.daniel-dwyer123.workers.dev/mcp",
    });
    await expect(
      registerExistingMcpEnvironment(db as unknown as D1Database, {
        companyId: "co_el",
        name: "Stolen",
        endpointUrl: "https://ht-business-mcp.daniel-dwyer123.workers.dev/mcp",
        authSecretRef: "EL_MCP_AUTH_TOKEN",
        actor: "admin@test",
      }),
    ).rejects.toThrow(/already registered to another company/);
  });

  it("attaches isolated HT and EL tenants with separate wallets and planned connectors", async () => {
    const db = new FakeD1();
    const ht = await attachExistingCompanyMcp(
      db as unknown as D1Database,
      EXISTING_PRODUCTION_COMPANY_MCPS[0],
      "admin@test",
    );
    const el = await attachExistingCompanyMcp(
      db as unknown as D1Database,
      EXISTING_PRODUCTION_COMPANY_MCPS[1],
      "admin@test",
    );

    expect(ht.company.id).toBe("co_ht");
    expect(el.company.id).toBe("co_el");
    expect(ht.company.slug).toBe("ht-business");
    expect(el.company.slug).toBe("el-business");
    expect(ht.mcp.endpointUrl).not.toBe(el.mcp.endpointUrl);
    expect(ht.mcp.authSecretRef).not.toBe(el.mcp.authSecretRef);
    expect(ht.mcp.authSecretRef).toBe("HT_MCP_AUTH_TOKEN");
    expect(el.mcp.authSecretRef).toBe("EL_MCP_AUTH_TOKEN");

    const htWallet = db.tables.credit_balances.find(
      (r) => r.company_id === ht.company.id,
    );
    const elWallet = db.tables.credit_balances.find(
      (r) => r.company_id === el.company.id,
    );
    expect(Number(htWallet?.balance_cents)).toBe(1000);
    expect(Number(elWallet?.balance_cents)).toBe(1000);
    expect(ht.company.id).not.toBe(el.company.id);

    expect(
      db.tables.connector_instances.some(
        (r) => r.company_id === ht.company.id && r.status === "draft",
      ),
    ).toBe(true);
    expect(
      db.tables.connector_instances.filter((r) => r.status === "configured"),
    ).toHaveLength(0);
  });
});
