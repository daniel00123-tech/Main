import { describe, expect, it } from "vitest";
import { issueInfraMcpAccessToken, verifyInfraMcpAccessToken } from "./tokens";
import { resolveLiveMcpPrincipal, sessionUserFromPrincipal } from "./principal";
import { verifyPkceS256, sha256Base64Url } from "./crypto";
import { inferConnectorFromTool, recordCompanyMcpUsage } from "./usage-report";
import { MCP_ACCESS_TYP } from "./types";
import type { Env } from "../../env";
import { userHasCompanyAccess } from "../../permissions/service";

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
  tables: Record<string, Row[]>;
  constructor(seed: Record<string, Row[]>) {
    this.tables = seed;
  }
  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }
  first(sql: string, binds: unknown[]): Row | null {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.includes("from users where id")) {
      return this.tables.users.find((r) => r.id === binds[0]) ?? null;
    }
    if (q.includes("from companies where id")) {
      return this.tables.companies.find((r) => r.id === binds[0]) ?? null;
    }
    if (q.includes("from companies where slug")) {
      return this.tables.companies.find((r) => r.slug === binds[0]) ?? null;
    }
    if (q.includes("from company_memberships") && q.includes("user_id") && q.includes("company_id")) {
      return (
        this.tables.company_memberships.find(
          (r) => r.user_id === binds[0] && r.company_id === binds[1],
        ) ?? null
      );
    }
    if (q.includes("from usage_records where request_id")) {
      return this.tables.usage_records.find((r) => r.request_id === binds[0]) ?? null;
    }
    if (q.includes("from usage_records where correlation_id")) {
      return this.tables.usage_records.find((r) => r.correlation_id === binds[0]) ?? null;
    }
    if (q.includes("from mcp_environments where company_id")) {
      return this.tables.mcp_environments?.find((r) => r.company_id === binds[0]) ?? null;
    }
    if (q.includes("from connector_instances")) {
      return this.tables.connector_instances?.[0] ?? null;
    }
    return null;
  }
  all(sql: string, binds: unknown[]): Row[] {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.includes("from mcp_environments")) {
      return (this.tables.mcp_environments ?? []).filter((r) => !binds[0] || r.company_id === binds[0]);
    }
    if (q.includes("from connector_instances")) {
      return (this.tables.connector_instances ?? []).filter((r) => !binds[0] || r.company_id === binds[0]);
    }
    return [];
  }
  run(sql: string, binds: unknown[]) {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.startsWith("insert into usage_records")) {
      this.tables.usage_records.push({
        id: binds[0],
        company_id: binds[1],
        resource_type: binds[2],
        resource_id: binds[3],
        user_id: binds[8],
        actor_email: binds[9],
        tool_name: binds[12],
        success: binds[15],
        source_client: binds[17],
        correlation_id: binds[18],
        request_id: binds[21],
        metadata_json: binds[7],
      });
    }
    if (q.startsWith("insert into audit_events") || q.includes("insert into audit")) {
      this.tables.audit_events = this.tables.audit_events ?? [];
      this.tables.audit_events.push({ id: binds[0] ?? "audit" });
    }
  }
}

function testEnv(db: FakeD1): Env {
  return {
    DB: db as unknown as D1Database,
    ENVIRONMENT: "test",
    SESSION_SECRET: "session-secret-for-tests",
    MCP_OAUTH_SECRET: "mcp-oauth-secret-for-tests",
    ALLOWED_ORIGINS: "http://localhost:5173",
    INFRA_PUBLIC_API_URL: "https://infra-api.example.test",
  };
}

const william = {
  id: "user_william",
  email: "william@elvexpropertyservices.com",
  display_name: "William Stone",
  password_hash: "hash",
  password_salt: "salt",
  is_platform_admin: 0,
  status: "active",
  last_login_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const company = {
  id: "co_el",
  slug: "el-business",
  name: "EL Business",
  status: "active",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

describe("INFRA MCP OAuth tokens", () => {
  it("issues a short-lived token with user, company, and client — never a role", async () => {
    const env = testEnv(new FakeD1({ users: [], companies: [], company_memberships: [], usage_records: [] }));
    const issued = await issueInfraMcpAccessToken(env, {
      userId: "user_william",
      companyId: "co_el",
      companySlug: "el-business",
      client: "chatgpt",
      email: william.email,
      name: "William Stone",
    });
    expect(issued).toBeTruthy();
    expect(issued!.claims.typ).toBe(MCP_ACCESS_TYP);
    expect(issued!.claims.sub).toBe("user_william");
    expect(issued!.claims.company_id).toBe("co_el");
    expect(issued!.claims.client).toBe("chatgpt");
    expect("role" in issued!.claims).toBe(false);
    const verified = await verifyInfraMcpAccessToken(env, issued!.accessToken);
    expect(verified?.sub).toBe("user_william");
    expect(verified?.company_slug).toBe("el-business");
  });

  it("rejects a token that encodes a role", async () => {
    const env = testEnv(new FakeD1({ users: [], companies: [], company_memberships: [], usage_records: [] }));
    const issued = await issueInfraMcpAccessToken(env, {
      userId: "user_william",
      companyId: "co_el",
      companySlug: "el-business",
      client: "chatgpt",
    });
    const { SignJWT } = await import("jose");
    const bad = await new SignJWT({
      typ: MCP_ACCESS_TYP,
      company_id: "co_el",
      company_slug: "el-business",
      client: "chatgpt",
      role: "company_admin",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("https://infra-api.example.test")
      .setAudience("https://infra-api.example.test/api/gateway/v1/mcp")
      .setSubject("user_william")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("mcp-oauth-secret-for-tests"));
    expect(await verifyInfraMcpAccessToken(env, bad)).toBeNull();
    expect(issued).toBeTruthy();
  });
});

describe("live INFRA membership", () => {
  it("resolves William as office_staff and fails closed when disabled or unknown", async () => {
    const db = new FakeD1({
      users: [william],
      companies: [company],
      company_memberships: [
        {
          user_id: "user_william",
          company_id: "co_el",
          role: "office_staff",
          status: "active",
        },
      ],
      usage_records: [],
    });
    const live = await resolveLiveMcpPrincipal(db as unknown as D1Database, {
      userId: "user_william",
      companyId: "co_el",
    });
    expect(live.ok).toBe(true);
    if (live.ok) {
      expect(live.principal.role).toBe("office_staff");
      const session = sessionUserFromPrincipal(live.principal);
      expect(userHasCompanyAccess(session, "co_el")).toBe(true);
      expect(userHasCompanyAccess(session, "co_ht")).toBe(false);
    }

    db.tables.users[0].status = "disabled";
    const disabled = await resolveLiveMcpPrincipal(db as unknown as D1Database, {
      userId: "user_william",
      companyId: "co_el",
    });
    expect(disabled.ok).toBe(false);

    const unknown = await resolveLiveMcpPrincipal(db as unknown as D1Database, {
      userId: "user_nobody",
      companyId: "co_el",
    });
    expect(unknown.ok).toBe(false);
  });

  it("role changes take effect without a new token", async () => {
    const db = new FakeD1({
      users: [william],
      companies: [company],
      company_memberships: [
        { user_id: "user_william", company_id: "co_el", role: "office_staff", status: "active" },
      ],
      usage_records: [],
    });
    const first = await resolveLiveMcpPrincipal(db as unknown as D1Database, {
      userId: "user_william",
      companyId: "co_el",
    });
    expect(first.ok && first.principal.role).toBe("office_staff");
    db.tables.company_memberships[0].role = "finance_team";
    const second = await resolveLiveMcpPrincipal(db as unknown as D1Database, {
      userId: "user_william",
      companyId: "co_el",
    });
    expect(second.ok && second.principal.role).toBe("finance_team");
  });
});

describe("PKCE and usage attribution", () => {
  it("requires S256 PKCE", async () => {
    const verifier = "william-pkce-verifier-abcdefghijklmnopqrstuvwxyz";
    const challenge = await sha256Base64Url(verifier);
    expect(await verifyPkceS256(verifier, challenge)).toBe(true);
    expect(await verifyPkceS256("wrong-verifier-abcdefghijklmnopqrstuvwxyz012", challenge)).toBe(false);
  });

  it("records generic company MCP usage for William + ChatGPT without payloads", async () => {
    const db = new FakeD1({
      users: [william],
      companies: [company],
      company_memberships: [],
      usage_records: [],
      mcp_environments: [{ id: "mcp_el", company_id: "co_el", auth_secret_ref: "EL_MCP_AUTH_TOKEN" }],
      connector_instances: [],
      audit_events: [],
    });
    const env = testEnv(db);
    const recorded = await recordCompanyMcpUsage(env, {
      companyId: "co_el",
      userId: "user_william",
      actorEmail: william.email,
      sourceClient: "chatgpt",
      toolName: "search_company_knowledge",
      success: true,
      correlationId: "corr_william_usage",
    });
    expect(recorded.ok).toBe(true);
    expect(db.tables.usage_records).toHaveLength(1);
    expect(db.tables.usage_records[0]).toMatchObject({
      company_id: "co_el",
      user_id: "user_william",
      actor_email: william.email,
      tool_name: "search_company_knowledge",
      source_client: "chatgpt",
    });
    expect(String(db.tables.usage_records[0].metadata_json)).not.toMatch(/prompt|inbox body/i);
    expect(inferConnectorFromTool("analyse_xero_sales")).toBe("xero");
  });
});
