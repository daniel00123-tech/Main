import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";

const { executeGatewayRequest } = vi.hoisted(() => ({
  executeGatewayRequest: vi.fn(),
}));

vi.mock("./gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gateway")>();
  return {
    ...actual,
    executeGatewayRequest,
  };
});

import { handleInfraMcpJsonRpc } from "./mcp-gateway";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./mcp-knowledge-standard";

type Row = Record<string, unknown>;

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
    if (q.includes("from mcp_environments where id")) {
      return this.tables.mcp_environments.find((r) => r.id === binds[0]) ?? null;
    }
    if (q.includes("from mcp_environments where company_id")) {
      return (
        this.tables.mcp_environments.find((r) => r.company_id === binds[0]) ??
        null
      );
    }
    if (q.includes("from companies where slug")) {
      return this.tables.companies.find((r) => r.slug === binds[0]) ?? null;
    }
    if (q.includes("from companies where id")) {
      return this.tables.companies.find((r) => r.id === binds[0]) ?? null;
    }
    if (q.includes("from permission_grants")) return null;
    return null;
  }

  all(sql: string, binds: unknown[]): Row[] {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.includes("from mcp_environments where company_id")) {
      return this.tables.mcp_environments.filter(
        (r) => r.company_id === binds[0],
      );
    }
    if (
      q.includes("from mcp_tool_allowlist") &&
      q.includes("enabled = 1") &&
      !q.includes("tool_name =")
    ) {
      return this.tables.mcp_tool_allowlist.filter(
        (r) => r.mcp_environment_id === binds[0] && Number(r.enabled) === 1,
      );
    }
    return [];
  }

  run() {
    return { success: true };
  }
}

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
    this.db.run();
    return { success: true };
  }
}

function serviceActor(
  companyId: string,
  mcpEnvironmentId: string,
  name = `${companyId} ChatGPT`,
) {
  return {
    type: "service" as const,
    identity: {
      id: `svc_${companyId}`,
      companyId,
      name,
      description: null,
      identityType: "chatgpt" as const,
      status: "active" as const,
      tokenPrefix: "infra_test",
      hasToken: true,
      scopes: ["knowledge.search", "knowledge.read", "system.health"],
      mcpEnvironmentId,
      lastUsedAt: null,
      requestCount: 0,
      createdAt: "t",
      updatedAt: "t",
    },
  };
}

function seedTwoTenants() {
  return new FakeD1({
    companies: [
      {
        id: "co_alpha",
        slug: "alpha-holdings",
        name: "Alpha Holdings",
        status: "active",
      },
      {
        id: "co_beta",
        slug: "beta-business",
        name: "Beta Business",
        status: "active",
      },
    ],
    mcp_environments: [
      {
        id: "mcp_alpha",
        company_id: "co_alpha",
        name: "Alpha MCP",
        endpoint_url: "https://alpha-mcp.test/mcp",
        enabled: 1,
        status: "healthy",
        auth_secret_ref: null,
        service_binding_ref: "ALPHA_MCP",
      },
      {
        id: "mcp_beta",
        company_id: "co_beta",
        name: "Beta MCP",
        endpoint_url: "https://beta-mcp.test/mcp",
        enabled: 1,
        status: "healthy",
        auth_secret_ref: null,
        service_binding_ref: "BETA_MCP",
      },
    ],
    mcp_tool_allowlist: [
      {
        mcp_environment_id: "mcp_alpha",
        tool_name: "search_company_knowledge",
        enabled: 1,
      },
      {
        mcp_environment_id: "mcp_alpha",
        tool_name: "get_knowledge_document",
        enabled: 1,
      },
      {
        mcp_environment_id: "mcp_alpha",
        tool_name: "system_health",
        enabled: 1,
      },
      {
        mcp_environment_id: "mcp_alpha",
        tool_name: "database_summary",
        enabled: 1,
      },
      {
        mcp_environment_id: "mcp_beta",
        tool_name: "search_company_knowledge",
        enabled: 1,
      },
      {
        mcp_environment_id: "mcp_beta",
        tool_name: "get_knowledge_document",
        enabled: 1,
      },
      {
        mcp_environment_id: "mcp_beta",
        tool_name: "system_health",
        enabled: 1,
      },
    ],
    mcp_tool_action_map: [],
    audit_events: [],
  });
}

function toolsForBinding(url: string) {
  const knowledge = [
    { name: "search_company_knowledge", description: "search" },
    { name: "get_knowledge_document", description: "read" },
    { name: "system_health", description: "health" },
    { name: "database_summary", description: "summary" },
  ];
  if (url.includes("beta-mcp")) {
    return knowledge.filter((tool) => tool.name !== "database_summary");
  }
  return knowledge;
}

function envFor(db: FakeD1): Env {
  const respond = (url: string) =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { tools: toolsForBinding(url) },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  return {
    DB: db as unknown as D1Database,
    ENVIRONMENT: "test",
    SESSION_SECRET: "x",
    ALLOWED_ORIGINS: "http://localhost:5173",
    ALPHA_MCP: { fetch: async (req: Request) => respond(String(req.url)) },
    BETA_MCP: { fetch: async (req: Request) => respond(String(req.url)) },
  } as unknown as Env;
}

function parseResult(payload: unknown) {
  return (
    payload as {
      result?: {
        content?: Array<{ type?: string; text?: string }>;
        structuredContent?: unknown;
        _infra?: unknown;
      };
      error?: { message?: string };
    }
  ).result;
}

describe("INFRA MCP Company Knowledge adaptors", () => {
  beforeEach(() => {
    executeGatewayRequest.mockReset();
  });

  it("advertises all six read-only tools with non-destructive annotations", async () => {
    const env = envFor(seedTwoTenants());
    const { payload } = await handleInfraMcpJsonRpc(
      env,
      new Request("https://infra.test/api/gateway/v1/mcp", { method: "POST" }),
      serviceActor("co_alpha", "mcp_alpha"),
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    );
    const tools = (
      payload as {
        result?: {
          tools?: Array<{
            name: string;
            inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
            annotations?: Record<string, unknown>;
          }>;
        };
      }
    ).result?.tools;
    const names = tools?.map((tool) => tool.name) ?? [];
    expect(names).toEqual([
      "search",
      "fetch",
      "search_company_knowledge",
      "get_knowledge_document",
      "system_health",
      "database_summary",
    ]);

    const search = tools?.find((tool) => tool.name === "search");
    const fetchTool = tools?.find((tool) => tool.name === "fetch");
    expect(search?.inputSchema?.required).toEqual(["query"]);
    expect(search?.inputSchema?.properties?.query).toBeTruthy();
    expect(fetchTool?.inputSchema?.required).toEqual(["id"]);
    expect(fetchTool?.inputSchema?.properties?.id).toBeTruthy();

    for (const name of [
      "search",
      "fetch",
      "search_company_knowledge",
      "get_knowledge_document",
      "system_health",
      "database_summary",
    ]) {
      const tool = tools?.find((item) => item.name === name);
      expect(tool?.annotations).toMatchObject(READ_ONLY_TOOL_ANNOTATIONS);
    }
  });

  it("search returns the boiler bonus policy and fetch can load that document", async () => {
    executeGatewayRequest.mockImplementation(async (_env, input) => {
      expect(input.companyId).toBe("co_alpha");
      if (input.toolName === "search") {
        expect(input.arguments).toEqual({ query: "boiler bonus policy" });
        return {
          status: 200,
          correlationId: "corr_search",
          requestId: "req_search",
          charge: { customerChargeCents: 1, isTestConfig: true },
          result: {
            results: [
              {
                id: "doc_boiler_bonus_001",
                title: "Boiler Sales Bonus process.docx",
                excerpt: "The boiler sales bonus is paid monthly.",
                source: "google_drive",
              },
            ],
          },
        };
      }
      if (input.toolName === "fetch") {
        expect(input.arguments).toEqual({ id: "doc_boiler_bonus_001" });
        return {
          status: 200,
          correlationId: "corr_fetch",
          requestId: "req_fetch",
          charge: { customerChargeCents: 1, isTestConfig: true },
          result: {
            id: "doc_boiler_bonus_001",
            title: "Boiler Sales Bonus process.docx",
            text: "Eligible engineers receive a monthly boiler sales bonus.",
            source: "google_drive",
          },
        };
      }
      throw new Error(`unexpected tool ${input.toolName}`);
    });

    const env = envFor(seedTwoTenants());
    const actor = serviceActor("co_alpha", "mcp_alpha");

    const search = await handleInfraMcpJsonRpc(
      env,
      new Request("https://infra.test/api/gateway/v1/mcp", { method: "POST" }),
      actor,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search", arguments: { query: "boiler bonus policy" } },
      },
    );
    const searchResult = parseResult(search.payload);
    const searchJson = JSON.parse(searchResult?.content?.[0]?.text ?? "{}") as {
      results: Array<{ id: string; title: string; snippet?: string }>;
    };
    expect(searchJson.results[0]?.title).toBe("Boiler Sales Bonus process.docx");
    expect(searchJson.results[0]?.id).toBe("doc_boiler_bonus_001");
    expect(searchResult?.structuredContent).toEqual(searchJson);

    const fetched = await handleInfraMcpJsonRpc(
      env,
      new Request("https://infra.test/api/gateway/v1/mcp", { method: "POST" }),
      actor,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "fetch",
          arguments: { id: searchJson.results[0]!.id },
        },
      },
    );
    const fetchResult = parseResult(fetched.payload);
    const fetchJson = JSON.parse(fetchResult?.content?.[0]?.text ?? "{}") as {
      id: string;
      title: string;
      text: string;
    };
    expect(fetchJson.id).toBe("doc_boiler_bonus_001");
    expect(fetchJson.title).toBe("Boiler Sales Bonus process.docx");
    expect(fetchJson.text).toContain("monthly boiler sales bonus");
    expect(fetchResult?.structuredContent).toEqual(fetchJson);
  });

  it("keeps existing search_company_knowledge and get_knowledge_document responses", async () => {
    executeGatewayRequest.mockImplementation(async (_env, input) => {
      if (input.toolName === "search_company_knowledge") {
        return {
          status: 200,
          correlationId: "corr_legacy_search",
          requestId: "req_legacy_search",
          charge: { customerChargeCents: 1 },
          result: {
            tenant: "alpha",
            query: "boiler bonus policy",
            results: [{ id: "doc_boiler_bonus_001", title: "Boiler Sales Bonus process.docx" }],
          },
        };
      }
      if (input.toolName === "get_knowledge_document") {
        return {
          status: 200,
          correlationId: "corr_legacy_read",
          requestId: "req_legacy_read",
          charge: { customerChargeCents: 1 },
          result: {
            id: "doc_boiler_bonus_001",
            title: "Boiler Sales Bonus process.docx",
            text: "legacy body",
          },
        };
      }
      throw new Error(`unexpected tool ${input.toolName}`);
    });

    const env = envFor(seedTwoTenants());
    const actor = serviceActor("co_alpha", "mcp_alpha");

    const search = await handleInfraMcpJsonRpc(
      env,
      new Request("https://infra.test/api/gateway/v1/mcp", { method: "POST" }),
      actor,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "search_company_knowledge",
          arguments: { query: "boiler bonus policy", topic: "policy" },
        },
      },
    );
    expect(executeGatewayRequest.mock.calls[0]?.[1]).toMatchObject({
      toolName: "search_company_knowledge",
      arguments: { query: "boiler bonus policy" },
    });
    const searchText = parseResult(search.payload)?.content?.[0]?.text ?? "";
    expect(searchText).toContain("tenant");
    expect(searchText).toContain("Boiler Sales Bonus process.docx");
    expect(parseResult(search.payload)?.structuredContent).toBeUndefined();

    const read = await handleInfraMcpJsonRpc(
      env,
      new Request("https://infra.test/api/gateway/v1/mcp", { method: "POST" }),
      actor,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "get_knowledge_document",
          arguments: { id: "doc_boiler_bonus_001" },
        },
      },
    );
    expect(executeGatewayRequest.mock.calls[1]?.[1]).toMatchObject({
      toolName: "get_knowledge_document",
    });
    expect(parseResult(read.payload)?.content?.[0]?.text).toContain("legacy body");
  });

  it("keeps system_health and database_summary working", async () => {
    executeGatewayRequest.mockImplementation(async (_env, input) => ({
      status: 200,
      correlationId: "corr_ok",
      requestId: "req_ok",
      charge: { customerChargeCents: 0, billable: false },
      result: { ok: true, tool: input.toolName },
    }));
    const env = envFor(seedTwoTenants());
    const actor = serviceActor("co_alpha", "mcp_alpha");

    for (const name of ["system_health", "database_summary"] as const) {
      const { payload } = await handleInfraMcpJsonRpc(
        env,
        new Request("https://infra.test/api/gateway/v1/mcp", { method: "POST" }),
        actor,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: {} },
        },
      );
      expect(parseResult(payload)?.content?.[0]?.text).toContain(name);
    }
  });

  it("does not return another tenant's search results or documents", async () => {
    executeGatewayRequest.mockImplementation(async (_env, input) => {
      if (input.companyId !== "co_beta") {
        throw new Error("tenant isolation violated");
      }
      if (input.toolName === "search") {
        return {
          status: 200,
          correlationId: "corr_beta_search",
          requestId: "req_beta_search",
          charge: { customerChargeCents: 1 },
          result: {
            results: [
              {
                id: "doc_beta_only",
                title: "Beta handbook",
                excerpt: "Beta-only policy",
              },
            ],
          },
        };
      }
      if (input.toolName === "fetch") {
        if (input.arguments?.id === "doc_boiler_bonus_001") {
          return {
            status: 404,
            error: "Document not found",
            correlationId: "corr_beta_miss",
            requestId: "req_beta_miss",
          };
        }
        return {
          status: 200,
          correlationId: "corr_beta_fetch",
          requestId: "req_beta_fetch",
          charge: { customerChargeCents: 1 },
          result: {
            id: "doc_beta_only",
            title: "Beta handbook",
            text: "Beta-only body",
          },
        };
      }
      throw new Error(`unexpected tool ${input.toolName}`);
    });

    const env = envFor(seedTwoTenants());
    const beta = serviceActor("co_beta", "mcp_beta", "Beta ChatGPT");

    const search = await handleInfraMcpJsonRpc(
      env,
      new Request("https://infra.test/api/gateway/v1/mcp", { method: "POST" }),
      beta,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search", arguments: { query: "boiler bonus policy" } },
      },
    );
    const searchJson = JSON.parse(
      parseResult(search.payload)?.content?.[0]?.text ?? "{}",
    ) as { results: Array<{ id: string; title: string }> };
    expect(searchJson.results.map((item) => item.id)).toEqual(["doc_beta_only"]);
    expect(searchJson.results.some((item) => item.id === "doc_boiler_bonus_001")).toBe(
      false,
    );

    const crossFetch = await handleInfraMcpJsonRpc(
      env,
      new Request("https://infra.test/api/gateway/v1/mcp", { method: "POST" }),
      beta,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "fetch",
          arguments: { id: "doc_boiler_bonus_001" },
        },
      },
    );
    expect(crossFetch.payload).toHaveProperty("error");
    expect(JSON.stringify(crossFetch.payload)).not.toContain("Boiler Sales Bonus");
    expect(JSON.stringify(crossFetch.payload)).not.toContain(
      "Eligible engineers receive a monthly bonus",
    );
  });

  it("rejects search/fetch tenant spoofing via params", async () => {
    const env = envFor(seedTwoTenants());
    const result = await handleInfraMcpJsonRpc(
      env,
      new Request("https://infra.test/api/gateway/v1/mcp", { method: "POST" }),
      serviceActor("co_beta", "mcp_beta"),
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          companyId: "co_alpha",
          name: "search",
          arguments: { query: "boiler bonus policy" },
        },
      },
    );
    expect(result.httpStatus).toBe(403);
    expect(executeGatewayRequest).not.toHaveBeenCalled();
  });
});
