import { describe, expect, it } from "vitest";
import {
  BASE_AI_SERVICE_SCOPES,
  serviceIdentityScopesWithXeroRead,
  serviceIdentityScopesWithXeroActionEngine,
  XERO_READ_SERVICE_SCOPES,
  XERO_ACTION_SERVICE_SCOPES,
} from "@infra/shared";
import {
  isXeroConnectedForCompany,
  isXeroWriteOAuthConnectedForCompany,
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
      const row = this.rows.connector_instances.find((candidate) => {
        if (candidate.company_id !== binds[0]) return false;
        if (q.includes("capabilities_enabled_json")) {
          return (
            candidate.connector_definition_id === "conn_xero" &&
            candidate.auth_status === "connected" &&
            !["draft", "disabled"].includes(String(candidate.status))
          );
        }
        return (
          candidate.connector_definition_id === "conn_xero" &&
          candidate.auth_status === "connected" &&
          !["draft", "disabled"].includes(String(candidate.status))
        );
      });
      return row ?? null;
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

  it("includes Action Engine scopes when Xero write OAuth is consented", async () => {
    const db = new FakeD1({
      connector_instances: [
        {
          company_id: "co_caddington",
          connector_definition_id: "conn_xero",
          auth_status: "connected",
          status: "healthy",
          capabilities_enabled_json: JSON.stringify([
            "offline_access",
            "accounting.invoices.read",
            "accounting.invoices",
          ]),
        },
      ],
      service_identities: [],
    });

    await expect(
      isXeroWriteOAuthConnectedForCompany(db as unknown as D1Database, "co_caddington"),
    ).resolves.toBe(true);

    const scopes = await resolveServiceIdentityScopesForCompany(
      db as unknown as D1Database,
      "co_caddington",
    );
    expect(scopes).toEqual(serviceIdentityScopesWithXeroActionEngine());
    expect(scopes).toEqual(expect.arrayContaining([...XERO_ACTION_SERVICE_SCOPES]));
  });

  it("keeps read-only scopes when Xero connected without write OAuth", async () => {
    const db = new FakeD1({
      connector_instances: [
        {
          company_id: "co_caddington",
          connector_definition_id: "conn_xero",
          auth_status: "connected",
          status: "healthy",
          capabilities_enabled_json: JSON.stringify(["accounting.invoices.read"]),
        },
      ],
      service_identities: [],
    });

    await expect(
      isXeroWriteOAuthConnectedForCompany(db as unknown as D1Database, "co_caddington"),
    ).resolves.toBe(false);

    const scopes = await resolveServiceIdentityScopesForCompany(
      db as unknown as D1Database,
      "co_caddington",
    );
    expect(scopes).toEqual(serviceIdentityScopesWithXeroRead());
    expect(scopes).not.toContain("xero.action.plan");
  });

  it("syncs active service identities without rotating tokens", async () => {
    const db = new FakeD1({
      connector_instances: [
        {
          company_id: "co_caddington",
          connector_definition_id: "conn_xero",
          auth_status: "connected",
          status: "healthy",
          capabilities_enabled_json: JSON.stringify(["accounting.invoices"]),
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
      serviceIdentityScopesWithXeroActionEngine(),
    );
    expect(db.rows.service_identities[0].token_hash).toBe("unchanged");
  });
});
