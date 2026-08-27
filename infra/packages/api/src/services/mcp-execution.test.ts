import { describe, expect, it, beforeEach, vi } from "vitest";
import { XERO_READ_MCP_TOOLS } from "@infra/shared";
import { app } from "../index";
import { hashPassword, generateSalt } from "../auth/password";
import { resolveMcpAuthHeader } from "../services/mcp-client";
import { isToolAllowed, ensureDefaultToolAllowlist } from "../services/control-plane";

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
    const rows = this.execute();
    return rows[0] ?? null;
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

    if (q.startsWith("select count(*) as count from users")) {
      return [{ count: this.table("users").length }];
    }
    if (q.includes("from users where email")) {
      const email = String(this.binds[0]).toLowerCase();
      return this.table("users").filter(
        (row) => String(row.email).toLowerCase() === email,
      );
    }
    if (q.includes("from users where id")) {
      return this.table("users").filter((row) => row.id === this.binds[0]);
    }
    if (q.includes("from company_memberships where user_id")) {
      return this.table("company_memberships").filter(
        (row) => row.user_id === this.binds[0] && row.status === "active",
      );
    }
    if (q.includes("from companies where slug")) {
      return this.table("companies").filter((row) => row.slug === this.binds[0]);
    }
    if (q.includes("from companies where id")) {
      return this.table("companies").filter((row) => row.id === this.binds[0]);
    }
    if (q.includes("from mcp_environments where id")) {
      return this.table("mcp_environments").filter((row) => row.id === this.binds[0]);
    }
    if (q.includes("from mcp_tool_allowlist") && q.includes("tool_name")) {
      return this.table("mcp_tool_allowlist").filter(
        (row) =>
          row.mcp_environment_id === this.binds[0] &&
          row.tool_name === this.binds[1],
      );
    }
    if (q.includes("from mcp_tool_allowlist") && q.includes("enabled = 1")) {
      return this.table("mcp_tool_allowlist").filter(
        (row) => row.mcp_environment_id === this.binds[0] && row.enabled === 1,
      );
    }
    if (q.includes("from usage_records") && q.includes("company_id")) {
      return this.table("usage_records")
        .filter((row) => row.company_id === this.binds[0])
        .sort((a, b) => String(b.recorded_at).localeCompare(String(a.recorded_at)));
    }
    if (q.includes("select count(*) as count from usage_records")) {
      const companyId = this.binds[0];
      let rows = this.table("usage_records").filter(
        (row) => row.company_id === companyId,
      );
      if (this.binds[1]) {
        rows = rows.filter(
          (row) => String(row.recorded_at) >= String(this.binds[1]),
        );
      }
      if (q.includes("success = 1")) {
        rows = rows.filter((row) => row.success === 1);
      }
      if (q.includes("success = 0")) {
        rows = rows.filter((row) => row.success === 0);
      }
      return [{ count: rows.length }];
    }
    if (q.includes("from audit_events")) {
      return this.table("audit_events");
    }
    return [];
  }

  private executeMutation() {
    const q = this.query.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.startsWith("insert into users")) {
      this.table("users").push({
        id: this.binds[0],
        email: this.binds[1],
        display_name: this.binds[2],
        password_hash: this.binds[3],
        password_salt: this.binds[4],
        is_platform_admin: this.binds[5],
        status: "active",
        created_at: this.binds[6],
        updated_at: this.binds[7],
      });
    }
    if (q.startsWith("insert into audit_events")) {
      this.table("audit_events").push({
        id: this.binds[0],
        company_id: this.binds[1],
        event_type: this.binds[2],
        actor: this.binds[3],
        resource_type: this.binds[4],
        resource_id: this.binds[5],
        detail_json: this.binds[6],
        created_at: this.binds[7],
      });
    }
    if (q.startsWith("insert or ignore into mcp_tool_allowlist")) {
      const existing = this.table("mcp_tool_allowlist").find(
        (row) =>
          row.mcp_environment_id === this.binds[2] &&
          row.tool_name === this.binds[3],
      );
      if (!existing) {
        this.table("mcp_tool_allowlist").push({
          id: this.binds[0],
          company_id: this.binds[1],
          mcp_environment_id: this.binds[2],
          tool_name: this.binds[3],
          risk_class: "low_risk",
          enabled: 1,
          created_at: this.binds[4],
          updated_at: this.binds[5],
        });
      }
    }
    if (q.startsWith("insert into usage_records")) {
      this.table("usage_records").push({
        id: this.binds[0],
        company_id: this.binds[1],
        resource_type: this.binds[2],
        resource_id: this.binds[3],
        quantity: this.binds[4],
        unit: this.binds[5],
        recorded_at: this.binds[6],
        metadata_json: this.binds[7],
        user_id: this.binds[8],
        actor_email: this.binds[9],
        mcp_environment_id: this.binds[10],
        connector_instance_id: this.binds[11],
        tool_name: this.binds[12],
        action: this.binds[13],
        risk_class: this.binds[14],
        success: this.binds[15],
        duration_ms: this.binds[16],
        source_client: this.binds[17],
        correlation_id: this.binds[18],
        underlying_cost_cents: this.binds[19],
        customer_charge_cents: this.binds[20],
      });
    }
    if (q.startsWith("update mcp_environments")) {
      const id = this.binds[this.binds.length - 1];
      const row = this.table("mcp_environments").find((item) => item.id === id);
      if (row) row.updated_at = new Date().toISOString();
    }
  }
}

async function seedUser(
  db: MockD1,
  input: {
    id: string;
    email: string;
    password: string;
    isPlatformAdmin?: boolean;
  },
) {
  const salt = generateSalt();
  const passwordHash = await hashPassword(input.password, salt);
  await db
    .prepare(
      `INSERT INTO users
        (id, email, display_name, password_hash, password_salt, is_platform_admin, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .bind(
      input.id,
      input.email,
      "Test User",
      passwordHash,
      salt,
      input.isPlatformAdmin ? 1 : 0,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    )
    .run();
}

function env(db: MockD1, extras: Record<string, unknown> = {}) {
  return {
    DB: db as unknown as D1Database,
    ENVIRONMENT: "development",
    SESSION_SECRET: "test-session-secret-at-least-32-characters",
    ALLOWED_ORIGINS: "http://localhost:5173",
    ...extras,
  };
}

async function loginCookie(db: MockD1, email: string, password: string) {
  const loginResponse = await app.request(
    "/api/auth/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    },
    env(db),
  );
  return loginResponse.headers.get("Set-Cookie") ?? "";
}

describe("resolveMcpAuthHeader", () => {
  it("never returns a secret when binding is missing", () => {
    const result = resolveMcpAuthHeader(
      env(new MockD1()) as never,
      "CADDINGTON_MCP_AUTH_TOKEN",
    );
    expect(result.authConfigured).toBe(false);
    expect(result.authorizationHeader).toBeNull();
  });

  it("resolves bearer token from secret ref name only", () => {
    const result = resolveMcpAuthHeader(
      env(new MockD1(), {
        CADDINGTON_MCP_AUTH_TOKEN: "secret-value",
      }) as never,
      "CADDINGTON_MCP_AUTH_TOKEN",
    );
    expect(result.authConfigured).toBe(true);
    expect(result.authorizationHeader).toBe("Bearer secret-value");
  });
});

describe("MCP tool allowlist", () => {
  it("denies tools that are not allowlisted", async () => {
    const db = new MockD1({
      mcp_tool_allowlist: [
        {
          id: "a1",
          company_id: "co_caddington",
          mcp_environment_id: "mcp_caddington_primary",
          tool_name: "search_company_knowledge",
          risk_class: "low_risk",
          enabled: 1,
        },
      ],
    });

    const allowed = await isToolAllowed(
      db as unknown as D1Database,
      "mcp_caddington_primary",
      "search_company_knowledge",
    );
    const denied = await isToolAllowed(
      db as unknown as D1Database,
      "mcp_caddington_primary",
      "query_business_data",
    );

    expect(allowed.allowed).toBe(true);
    expect(denied.allowed).toBe(false);

    const aliased = await isToolAllowed(
      db as unknown as D1Database,
      "mcp_caddington_primary",
      "search",
    );
    expect(aliased.allowed).toBe(true);
    expect(aliased.riskClass).toBe("low_risk");
  });

  it("seeds default read-only allowlist entries", async () => {
    const db = new MockD1({ mcp_tool_allowlist: [] });
    await ensureDefaultToolAllowlist(
      db as unknown as D1Database,
      "co_caddington",
      "mcp_caddington_primary",
    );
    const names = (db.tables.get("mcp_tool_allowlist") ?? []).map((row) =>
      String(row.tool_name),
    );
    expect(names).toEqual(
      expect.arrayContaining([
        "search_company_knowledge",
        "system_health",
        "database_summary",
        "get_knowledge_document",
        ...XERO_READ_MCP_TOOLS,
      ]),
    );
    expect(names).not.toContain("xero_create_draft_invoice");
    expect(names).toHaveLength(4 + XERO_READ_MCP_TOOLS.length);
  });
});

describe("company-scoped usage isolation", () => {
  let db: MockD1;

  beforeEach(() => {
    db = new MockD1({
      companies: [
        {
          id: "co_caddington",
          slug: "caddington-holdings",
          name: "Caddington Holdings",
          status: "active",
          primary_domain: null,
          notes: null,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "co_el",
          slug: "el-business",
          name: "EL Business",
          status: "active",
          primary_domain: null,
          notes: null,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      company_memberships: [
        {
          id: "mem_1",
          user_id: "user_cad",
          company_id: "co_caddington",
          role: "company_admin",
          status: "active",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      usage_records: [
        {
          id: "usage_cad",
          company_id: "co_caddington",
          resource_type: "mcp_tool",
          resource_id: "search_company_knowledge",
          quantity: 1,
          unit: "request",
          recorded_at: "2026-08-24T12:00:00.000Z",
          metadata_json: "{}",
          success: 1,
          tool_name: "search_company_knowledge",
          actor_email: "admin@example.com",
        },
        {
          id: "usage_el",
          company_id: "co_el",
          resource_type: "mcp_tool",
          resource_id: "search_company_knowledge",
          quantity: 1,
          unit: "request",
          recorded_at: "2026-08-24T12:00:00.000Z",
          metadata_json: "{}",
          success: 1,
          tool_name: "search_company_knowledge",
          actor_email: "el@example.com",
        },
      ],
      audit_events: [],
      mcp_environments: [
        {
          id: "mcp_caddington_primary",
          company_id: "co_caddington",
          name: "Caddington MCP",
          description: null,
          endpoint_url: "https://caddington-mcp.example/mcp",
          transport: "sse",
          status: "healthy",
          enabled: 1,
          is_external: 1,
          data_plane_id: null,
          mcp_version: null,
          business_mcp_core_version: null,
          capabilities_json: "[]",
          auth_secret_ref: "CADDINGTON_MCP_AUTH_TOKEN",
          last_health_check_at: null,
          last_healthy_at: null,
          health_message: null,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      mcp_tool_allowlist: [
        {
          id: "a1",
          company_id: "co_caddington",
          mcp_environment_id: "mcp_caddington_primary",
          tool_name: "search_company_knowledge",
          risk_class: "low_risk",
          enabled: 1,
        },
      ],
    });
  });

  it("denies company users from reading another company usage", async () => {
    await seedUser(db, {
      id: "user_cad",
      email: "cad@example.com",
      password: "CompanyPassword123!",
    });
    const cookie = await loginCookie(db, "cad@example.com", "CompanyPassword123!");

    const denied = await app.request(
      "/api/companies/el-business/usage",
      { headers: { Cookie: cookie } },
      env(db),
    );
    expect(denied.status).toBe(403);
  });

  it("returns only the company usage for an authorized member", async () => {
    await seedUser(db, {
      id: "user_cad",
      email: "cad@example.com",
      password: "CompanyPassword123!",
    });
    const cookie = await loginCookie(db, "cad@example.com", "CompanyPassword123!");

    const allowed = await app.request(
      "/api/companies/caddington-holdings/usage",
      { headers: { Cookie: cookie } },
      env(db),
    );
    expect(allowed.status).toBe(200);
    const body = (await allowed.json()) as {
      companyId: string;
      records: Array<{ id: string }>;
    };
    expect(body.companyId).toBe("co_caddington");
    expect(body.records.map((r) => r.id)).toEqual(["usage_cad"]);
  });

  it("denies non-platform-admin MCP execute", async () => {
    await seedUser(db, {
      id: "user_cad",
      email: "cad@example.com",
      password: "CompanyPassword123!",
    });
    const cookie = await loginCookie(db, "cad@example.com", "CompanyPassword123!");

    const denied = await app.request(
      "/api/mcp-environments/mcp_caddington_primary/execute",
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          toolName: "search_company_knowledge",
          arguments: { query: "leave policy" },
        }),
      },
      env(db),
    );
    expect(denied.status).toBe(403);
  });

  it("rejects non-allowlisted tools for platform admin execute", async () => {
    await seedUser(db, {
      id: "user_admin",
      email: "admin@example.com",
      password: "StrongPassword123!",
      isPlatformAdmin: true,
    });
    const cookie = await loginCookie(db, "admin@example.com", "StrongPassword123!");

    const denied = await app.request(
      "/api/mcp-environments/mcp_caddington_primary/execute",
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          toolName: "query_business_data",
          arguments: { sql: "select 1" },
        }),
      },
      env(db),
    );
    expect(denied.status).toBe(403);
  });
});

describe("executeRegisteredMcpTool records usage and audit", () => {
  it("records success path with correlation id", async () => {
    const db = new MockD1({
      companies: [
        {
          id: "co_caddington",
          slug: "caddington-holdings",
          name: "Caddington",
          status: "active",
          primary_domain: null,
          notes: null,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      mcp_environments: [
        {
          id: "mcp_caddington_primary",
          company_id: "co_caddington",
          name: "Caddington MCP",
          description: null,
          endpoint_url: "https://caddington-mcp.example/mcp",
          transport: "sse",
          status: "healthy",
          enabled: 1,
          is_external: 1,
          data_plane_id: null,
          mcp_version: null,
          business_mcp_core_version: null,
          capabilities_json: "[]",
          auth_secret_ref: null,
          last_health_check_at: null,
          last_healthy_at: null,
          health_message: null,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      mcp_tool_allowlist: [],
      usage_records: [],
      audit_events: [],
      company_memberships: [],
    });

    await seedUser(db, {
      id: "user_admin",
      email: "admin@example.com",
      password: "StrongPassword123!",
      isPlatformAdmin: true,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    answer: "Annual leave is 25 days.",
                    results: [{ title: "Leave Policy" }],
                  }),
                },
              ],
            },
          }),
      })),
    );

    const cookie = await loginCookie(db, "admin@example.com", "StrongPassword123!");
    const response = await app.request(
      "/api/mcp-environments/mcp_caddington_primary/execute",
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          toolName: "search_company_knowledge",
          arguments: { query: "What does the company annual leave policy say?" },
        }),
      },
      env(db),
    );

    const payload = await response.json();
    expect(response.status, JSON.stringify(payload)).toBe(200);
    const body = payload as { correlationId: string; toolName: string };
    expect(body.toolName).toBe("search_company_knowledge");
    expect(body.correlationId).toMatch(/^corr_/);

    expect(db.tables.get("usage_records")?.length).toBe(1);
    expect(db.tables.get("audit_events")?.some((e) => e.event_type === "mcp.execution_succeeded")).toBe(
      true,
    );

    vi.unstubAllGlobals();
  });
});
