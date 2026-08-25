import { describe, expect, it } from "vitest";
import {
  BASE_AI_SERVICE_SCOPES,
  serviceIdentityScopesWithXeroRead,
  XERO_READ_SERVICE_SCOPES,
} from "@infra/shared";
import {
  isXeroConnectedForCompany,
  resolveServiceIdentityScopesForCompany,
  syncActiveServiceIdentityScopesForCompany,
} from "./service-identity-scopes";

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

  async run() {
    return this.db.run(this.sql, this.binds);
  }
}

class FakeD1 {
  readonly rows: { connector_instances: Row[]; service_identities: Row[] };

  constructor(tables: { connector_instances: Row[]; service_identities: Row[] }) {
    this.rows = tables;
  }

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  first(sql: string, binds: unknown[]) {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.includes("from connector_instances")) {
      return (
        this.rows.connector_instances.find(
          (row) =>
            row.company_id === binds[0] &&
            row.connector_definition_id === "conn_xero" &&
            row.auth_status === "connected" &&
            !["draft", "disabled"].includes(String(row.status)),
        ) ?? null
      );
    }
    return null;
  }

  run(sql: string, binds: unknown[]) {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.includes("update service_identities set scopes_json")) {
      for (const row of this.rows.service_identities) {
        if (row.company_id === binds[2] && row.status === "active") {
          row.scopes_json = binds[0];
          row.updated_at = binds[1];
        }
      }
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }
}

describe("service identity scopes", () => {
  it("includes Xero read actions when Xero OAuth is connected", async () => {
    const db = new FakeD1({
      connector_instances: [
        {
          company_id: "co_caddington",
          connector_definition_id: "conn_xero",
          auth_status: "connected",
          status: "healthy",
        },
      ],
      service_identities: [],
    });

    await expect(
      isXeroConnectedForCompany(db as unknown as D1Database, "co_caddington"),
    ).resolves.toBe(true);

    const scopes = await resolveServiceIdentityScopesForCompany(
      db as unknown as D1Database,
      "co_caddington",
    );
    expect(scopes).toEqual(
      expect.arrayContaining([...BASE_AI_SERVICE_SCOPES, ...XERO_READ_SERVICE_SCOPES]),
    );
    expect(scopes).toContain("xero.sales.summary");
    expect(scopes).toContain("xero.top_customers");
  });

  it("keeps knowledge-only scopes when Xero is not connected", async () => {
    const db = new FakeD1({
      connector_instances: [],
      service_identities: [],
    });
    const scopes = await resolveServiceIdentityScopesForCompany(
      db as unknown as D1Database,
      "co_other",
    );
    expect(scopes).toEqual([...BASE_AI_SERVICE_SCOPES]);
    expect(scopes).not.toContain("xero.sales.summary");
  });

  it("syncs active service identities without rotating tokens", async () => {
    const db = new FakeD1({
      connector_instances: [
        {
          company_id: "co_caddington",
          connector_definition_id: "conn_xero",
          auth_status: "connected",
          status: "healthy",
        },
      ],
      service_identities: [
        {
          company_id: "co_caddington",
          status: "active",
          scopes_json: JSON.stringify([...BASE_AI_SERVICE_SCOPES]),
          token_hash: "unchanged",
        },
      ],
    });

    const synced = await syncActiveServiceIdentityScopesForCompany(
      db as unknown as D1Database,
      "co_caddington",
    );
    expect(synced.updated).toBe(1);
    expect(JSON.parse(String(db.rows.service_identities[0].scopes_json))).toEqual(
      serviceIdentityScopesWithXeroRead(),
    );
    expect(db.rows.service_identities[0].token_hash).toBe("unchanged");
  });
});
