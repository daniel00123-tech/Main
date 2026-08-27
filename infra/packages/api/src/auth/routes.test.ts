import { describe, expect, it, beforeEach } from "vitest";
import { app } from "../index";
import { hashPassword, generateSalt } from "../auth/password";

type Row = Record<string, unknown>;

class MockD1 {
  private tables = new Map<string, Row[]>();

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
    if (!this.tables.has(name)) {
      this.tables.set(name, []);
    }
    return this.tables.get(name)!;
  }

  private execute(): Row[] {
    const q = this.query.replace(/\s+/g, " ").trim().toLowerCase();

    if (q.startsWith("select count(*) as count from users")) {
      return [{ count: this.table("users").length }];
    }

    if (q.includes("from users") && q.includes("email")) {
      const email = String(this.binds[0]).toLowerCase();
      return this.table("users").filter(
        (row) => String(row.email).toLowerCase() === email,
      );
    }

    if (q.includes("from users where id")) {
      return this.table("users").filter((row) => row.id === this.binds[0]);
    }

    if (q.includes("from users order by email")) {
      return [...this.table("users")].sort((a, b) =>
        String(a.email).localeCompare(String(b.email)),
      );
    }

    if (q.includes("from company_memberships where user_id")) {
      return this.table("company_memberships").filter(
        (row) => row.user_id === this.binds[0] && row.status === "active",
      );
    }

    if (q.includes("from company_memberships where status = 'active'")) {
      return this.table("company_memberships").filter(
        (row) => row.status === "active",
      );
    }

    if (q.includes("from companies order by name")) {
      return [...this.table("companies")].sort((a, b) =>
        String(a.name).localeCompare(String(b.name)),
      );
    }

    if (q.includes("from companies where slug")) {
      return this.table("companies").filter((row) => row.slug === this.binds[0]);
    }

    if (q.includes("from companies where id")) {
      return this.table("companies").filter((row) => row.id === this.binds[0]);
    }

    if (q.includes("from role_action_grants")) {
      return this.table("role_action_grants").filter(
        (row) => row.company_id === this.binds[0],
      );
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

    if (q.startsWith("update users set last_login_at")) {
      const row = this.table("users").find((r) => r.id === this.binds[2]);
      if (row) {
        row.last_login_at = this.binds[0];
        row.updated_at = this.binds[1];
      }
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

function env(db: MockD1) {
  return {
    DB: db as unknown as D1Database,
    ENVIRONMENT: "development",
    SESSION_SECRET: "test-session-secret-at-least-32-characters",
    ALLOWED_ORIGINS: "http://localhost:5173",
  };
}

describe("auth-protected API routes", () => {
  let db: MockD1;

  beforeEach(() => {
    db = new MockD1({
      companies: [
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
        {
          id: "co_ht",
          slug: "ht-business",
          name: "HT Business",
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
          user_id: "user_el",
          company_id: "co_el",
          role: "office_staff",
          status: "active",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      audit_events: [],
    });
  });

  it("denies unauthenticated company access", async () => {
    const response = await app.request("/api/companies", {}, env(db));
    expect(response.status).toBe(401);
  });

  it("allows valid login and session lookup", async () => {
    await seedUser(db, {
      id: "user_admin",
      email: "admin@example.com",
      password: "StrongPassword123!",
      isPlatformAdmin: true,
    });

    const loginResponse = await app.request(
      "/api/auth/login",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:5173",
        },
        body: JSON.stringify({
          email: "admin@example.com",
          password: "StrongPassword123!",
        }),
      },
      env(db),
    );

    expect(loginResponse.status).toBe(200);
    const cookie = loginResponse.headers.get("Set-Cookie");
    expect(cookie).toContain("infra_session=");

    const meResponse = await app.request(
      "/api/auth/me",
      {
        headers: {
          Cookie: cookie ?? "",
          Origin: "http://localhost:5173",
        },
      },
      env(db),
    );
    expect(meResponse.status).toBe(200);
    const body = (await meResponse.json()) as { email: string };
    expect(body.email).toBe("admin@example.com");
  });

  it("rejects invalid login", async () => {
    await seedUser(db, {
      id: "user_admin",
      email: "admin@example.com",
      password: "StrongPassword123!",
      isPlatformAdmin: true,
    });

    const response = await app.request(
      "/api/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "admin@example.com",
          password: "wrong-password",
        }),
      },
      env(db),
    );

    expect(response.status).toBe(401);
  });

  it("denies cross-company overview access", async () => {
    await seedUser(db, {
      id: "user_el",
      email: "charlie@el.example",
      password: "CompanyPassword123!",
    });

    const loginResponse = await app.request(
      "/api/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "charlie@el.example",
          password: "CompanyPassword123!",
        }),
      },
      env(db),
    );
    const cookie = loginResponse.headers.get("Set-Cookie") ?? "";

    const denied = await app.request(
      "/api/companies/ht-business/overview",
      { headers: { Cookie: cookie } },
      env(db),
    );
    expect(denied.status).toBe(403);
  });
});
