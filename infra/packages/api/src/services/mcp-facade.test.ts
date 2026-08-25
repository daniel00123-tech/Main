import { describe, expect, it } from "vitest";
import {
  enrichMcpToolDescription,
  handleInfraMcpJsonRpc,
  narrowKnowledgeSearchInputSchema,
  pickInteractionHints,
  resolveMcpClientRequestId,
  sanitizeKnowledgeSearchArguments,
  wantsSse,
} from "./mcp-gateway";
import { ACTION_CONTROL_TOOLS } from "./mcp-action-tools";
import { extractServiceCredential } from "./gateway";
import type { Env } from "../env";

function withActionTools(names: string[]): string[] {
  return [...new Set([...names, ...ACTION_CONTROL_TOOLS])].sort();
}

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
    if (q.includes("from mcp_environments where id")) {
      return this.tables.mcp_environments.find((r) => r.id === binds[0]) ?? null;
    }
    if (q.includes("from mcp_environments where company_id")) {
      return (
        this.tables.mcp_environments.find((r) => r.company_id === binds[0]) ??
        null
      );
    }
    if (q.includes("from mcp_tool_action_map")) {
      return (
        this.tables.mcp_tool_action_map.find(
          (r) =>
            r.mcp_environment_id === binds[0] && r.tool_name === binds[1],
        ) ?? null
      );
    }
    if (q.includes("from mcp_tool_allowlist") && q.includes("tool_name =")) {
      return (
        this.tables.mcp_tool_allowlist.find(
          (r) =>
            r.mcp_environment_id === binds[0] &&
            r.tool_name === binds[1] &&
            Number(r.enabled) === 1,
        ) ?? null
      );
    }
    if (q.includes("from permission_grants")) {
      return null;
    }
    if (q.includes("from companies where slug")) {
      return (
        (this.tables.companies ?? []).find((r) => r.slug === binds[0]) ?? null
      );
    }
    if (q.includes("from companies where id")) {
      return (
        (this.tables.companies ?? []).find((r) => r.id === binds[0]) ?? null
      );
    }
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

  run(sql: string, binds: unknown[]) {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.startsWith("insert into audit_events")) {
      this.tables.audit_events.push({
        id: binds[0],
        company_id: binds[1],
        event_type: binds[2],
        actor: binds[3],
        detail_json: binds[6],
      });
    }
  }
}

describe("INFRA MCP content negotiation", () => {
  it("prefers JSON when ChatGPT advertises both JSON and SSE", () => {
    const req = new Request("https://infra.test/mcp", {
      headers: { Accept: "application/json, text/event-stream" },
    });
    expect(wantsSse(req)).toBe(false);
  });

  it("uses SSE only when Accept is event-stream exclusive", () => {
    const req = new Request("https://infra.test/mcp", {
      headers: { Accept: "text/event-stream" },
    });
    expect(wantsSse(req)).toBe(true);
  });
});

describe("INFRA MCP credential extraction", () => {
  it("reads Bearer Authorization", () => {
    const req = new Request("https://infra.test/mcp", {
      headers: { Authorization: "Bearer infra_abc" },
    });
    expect(extractServiceCredential(req)).toBe("infra_abc");
  });

  it("reads X-Api-Key without weakening validation", () => {
    const req = new Request("https://infra.test/mcp", {
      headers: { "X-Api-Key": "infra_from_api_key" },
    });
    expect(extractServiceCredential(req)).toBe("infra_from_api_key");
  });
});

describe("INFRA MCP tool descriptions", () => {
  it("exposes clear knowledge-search guidance for ChatGPT", () => {
    const desc = enrichMcpToolDescription("search_company_knowledge", "vague");
    expect(desc.toLowerCase()).toContain("knowledge");
    expect(desc.toLowerCase()).toContain("company");
    expect(desc.toLowerCase()).toContain("topic");
  });
});

describe("ChatGPT search argument + idempotency guards", () => {
  it("does not treat JSON-RPC message id as an idempotency key", () => {
    const req = new Request("https://infra.test/mcp", { method: "POST" });
    expect(
      resolveMcpClientRequestId(req, {
        id: 0,
        params: { name: "search_company_knowledge", arguments: { query: "x" } },
      }),
    ).toBeNull();
  });

  it("honours explicit requestId / header", () => {
    const req = new Request("https://infra.test/mcp", {
      method: "POST",
      headers: { "X-Infra-Request-Id": "hdr-1" },
    });
    expect(resolveMcpClientRequestId(req, { id: 0, params: {} })).toBe("hdr-1");
    expect(
      resolveMcpClientRequestId(new Request("https://infra.test/mcp"), {
        id: 0,
        params: { requestId: "explicit-1" },
      }),
    ).toBe("explicit-1");
  });

  it("reads interaction hints without using JSON-RPC id", () => {
    const req = new Request("https://infra.test/mcp", {
      method: "POST",
      headers: {
        "X-Infra-Interaction-Id": "int_turn_1",
        "Mcp-Session-Id": "sess_abc",
      },
    });
    const hints = pickInteractionHints(req, {
      params: { _meta: { interactionId: "int_other" } },
    });
    expect(hints.interactionId).toBe("int_turn_1");
    expect(hints.mcpSessionId).toBe("sess_abc");
    const none = pickInteractionHints(new Request("https://infra.test/mcp"), {
      params: {},
    });
    expect(none.interactionId).toBeNull();
  });

  it("strips ChatGPT-invented topic filters that zero Caddington results", () => {
    const { forwarded, strippedKeys } = sanitizeKnowledgeSearchArguments({
      query: "vehicle policy",
      topK: 5,
      topic: "policy",
      includeNeighbourContext: true,
      department: "ops",
    });
    expect(forwarded).toEqual({
      query: "vehicle policy",
      topK: 5,
      includeNeighbourContext: true,
    });
    expect(strippedKeys.sort()).toEqual(["department", "topic"]);
  });

  it("narrows search schema so ChatGPT does not see topic filters", () => {
    const narrowed = narrowKnowledgeSearchInputSchema({
      type: "object",
      properties: {
        query: { type: "string" },
        topic: { type: "string" },
        topK: { type: "integer" },
        department: { type: "string" },
        title: { type: "string" },
      },
      required: ["query"],
    });
    const props = narrowed.properties as Record<string, unknown>;
    expect(props.query).toBeTruthy();
    expect(props.topK).toBeTruthy();
    expect(props.title).toBeTruthy();
    expect(props.topic).toBeUndefined();
    expect(props.department).toBeUndefined();
    expect(narrowed.additionalProperties).toBe(false);
  });
});

describe("INFRA MCP facade tool catalogue consistency", () => {
  it("tools/list only advertises tools the ChatGPT identity can execute", async () => {
    const db = new FakeD1({
      mcp_environments: [
        {
          id: "mcp_caddington_primary",
          company_id: "co_caddington",
          name: "Caddington MCP",
          endpoint_url: "https://example.test/mcp",
          enabled: 1,
          status: "healthy",
          auth_secret_ref: null,
          service_binding_ref: "CADDINGTON_MCP",
        },
      ],
      mcp_tool_allowlist: [
        {
          mcp_environment_id: "mcp_caddington_primary",
          tool_name: "search_company_knowledge",
          enabled: 1,
        },
        {
          mcp_environment_id: "mcp_caddington_primary",
          tool_name: "query_business_data",
          enabled: 1,
        },
        {
          mcp_environment_id: "mcp_caddington_primary",
          tool_name: "system_health",
          enabled: 1,
        },
      ],
      mcp_tool_action_map: [
        {
          mcp_environment_id: "mcp_caddington_primary",
          tool_name: "search_company_knowledge",
          action: "knowledge.search",
        },
        {
          mcp_environment_id: "mcp_caddington_primary",
          tool_name: "query_business_data",
          action: "mcp.query_business_data",
        },
        {
          mcp_environment_id: "mcp_caddington_primary",
          tool_name: "system_health",
          action: "system.health",
        },
      ],
      audit_events: [],
    });

    const env = {
      DB: db as unknown as D1Database,
      ENVIRONMENT: "test",
      SESSION_SECRET: "x",
      ALLOWED_ORIGINS: "http://localhost:5173",
      CADDINGTON_MCP: {
        fetch: async () =>
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              result: {
                tools: [
                  {
                    name: "search_company_knowledge",
                    description: "search",
                    inputSchema: {
                      type: "object",
                      properties: {
                        query: { type: "string" },
                        topic: { type: "string" },
                        topK: { type: "integer" },
                      },
                      required: ["query"],
                    },
                  },
                  { name: "query_business_data", description: "sql" },
                  { name: "system_health", description: "health" },
                ],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      },
    } as unknown as Env;

    const actor = {
      type: "service" as const,
      identity: {
        id: "svc_chatgpt",
        companyId: "co_caddington",
        name: "Caddington Holdings ChatGPT",
        description: null,
        identityType: "chatgpt" as const,
        status: "active" as const,
        tokenPrefix: "infra_test",
        hasToken: true,
        scopes: ["knowledge.search", "knowledge.read", "system.health"],
        mcpEnvironmentId: "mcp_caddington_primary",
        lastUsedAt: null,
        requestCount: 0,
        createdAt: "t",
        updatedAt: "t",
      },
    };

    const { payload } = await handleInfraMcpJsonRpc(
      env,
      new Request("https://infra.test/api/gateway/v1/mcp", { method: "POST" }),
      actor,
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    );

    const tools = (
      payload as {
        result?: {
          tools?: Array<{
            name: string;
            description?: string;
            inputSchema?: { properties?: Record<string, unknown> };
            annotations?: {
              readOnlyHint?: boolean;
              destructiveHint?: boolean;
              openWorldHint?: boolean;
            };
          }>;
        };
      }
    ).result?.tools;
    expect(tools?.map((t) => t.name).sort()).toEqual(
      withActionTools(["search", "search_company_knowledge", "system_health"]),
    );
    expect(tools?.some((t) => t.name === "query_business_data")).toBe(false);
    const search = tools?.find((t) => t.name === "search_company_knowledge");
    expect(search?.description?.toLowerCase()).toContain("knowledge");
    expect(search?.inputSchema?.properties?.query).toBeTruthy();
    expect(search?.inputSchema?.properties?.topic).toBeUndefined();
    const standard = tools?.find((t) => t.name === "search");
    expect(standard?.inputSchema?.properties?.query).toBeTruthy();
    expect(standard?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(search?.annotations?.readOnlyHint).toBe(true);
  });
});

function serviceActor(
  companyId: string,
  name: string,
  mcpEnvironmentId: string,
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

describe("tenant isolation across Caddington / HT / EL identities", () => {
  function threeTenantDb() {
    return new FakeD1({
      companies: [
        {
          id: "co_caddington",
          slug: "caddington-holdings",
          name: "Caddington Holdings",
          status: "active",
          created_at: "t",
          updated_at: "t",
        },
        {
          id: "co_ht",
          slug: "ht-business",
          name: "HT Business",
          status: "active",
          created_at: "t",
          updated_at: "t",
        },
        {
          id: "co_el",
          slug: "el-business",
          name: "EL Business",
          status: "active",
          created_at: "t",
          updated_at: "t",
        },
      ],
      mcp_environments: [
        {
          id: "mcp_caddington_primary",
          company_id: "co_caddington",
          name: "Caddington MCP",
          endpoint_url: "https://caddington-mcp.daniel-dwyer123.workers.dev/mcp",
          enabled: 1,
          status: "healthy",
          auth_secret_ref: "CADDINGTON_MCP_AUTH_TOKEN",
          service_binding_ref: "CADDINGTON_MCP",
        },
        {
          id: "mcp_ht_primary",
          company_id: "co_ht",
          name: "HT Business MCP",
          endpoint_url: "https://ht-business-mcp.daniel-dwyer123.workers.dev/mcp",
          enabled: 1,
          status: "healthy",
          auth_secret_ref: "HT_MCP_AUTH_TOKEN",
          service_binding_ref: "HT_BUSINESS_MCP",
        },
        {
          id: "mcp_el_primary",
          company_id: "co_el",
          name: "EL Business MCP",
          endpoint_url: "https://el-business-mcp.daniel-dwyer123.workers.dev/mcp",
          enabled: 1,
          status: "healthy",
          auth_secret_ref: "EL_MCP_AUTH_TOKEN",
          service_binding_ref: "EL_BUSINESS_MCP",
        },
      ],
      mcp_tool_allowlist: [
        {
          mcp_environment_id: "mcp_caddington_primary",
          tool_name: "search_company_knowledge",
          enabled: 1,
        },
        {
          mcp_environment_id: "mcp_caddington_primary",
          tool_name: "system_health",
          enabled: 1,
        },
        {
          mcp_environment_id: "mcp_ht_primary",
          tool_name: "system_health",
          enabled: 1,
        },
        {
          mcp_environment_id: "mcp_ht_primary",
          tool_name: "database_summary",
          enabled: 1,
        },
        {
          mcp_environment_id: "mcp_el_primary",
          tool_name: "system_health",
          enabled: 1,
        },
      ],
      mcp_tool_action_map: [],
      audit_events: [],
    });
  }

  function toolsForUrl(url: string) {
    if (url.includes("ht-business-mcp")) {
      return [
        { name: "system_health", description: "ht health" },
        { name: "database_summary", description: "ht warehouse" },
      ];
    }
    if (url.includes("el-business-mcp")) {
      return [{ name: "system_health", description: "el health" }];
    }
    return [
      { name: "search_company_knowledge", description: "cad search" },
      { name: "system_health", description: "cad health" },
    ];
  }

  function envFor(db: FakeD1): Env {
    const fetchFor = (url: string) =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { tools: toolsForUrl(url) },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    return {
      DB: db as unknown as D1Database,
      ENVIRONMENT: "test",
      SESSION_SECRET: "x",
      ALLOWED_ORIGINS: "http://localhost:5173",
      CADDINGTON_MCP: { fetch: async (req: Request) => fetchFor(req.url) },
      HT_BUSINESS_MCP: { fetch: async (req: Request) => fetchFor(req.url) },
      EL_BUSINESS_MCP: { fetch: async (req: Request) => fetchFor(req.url) },
    } as unknown as Env;
  }

  async function listTools(env: Env, actor: ReturnType<typeof serviceActor>) {
    const { payload } = await handleInfraMcpJsonRpc(
      env,
      new Request("https://infra.test/api/gateway/v1/mcp", { method: "POST" }),
      actor,
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    );
    return (
      payload as { result?: { tools?: Array<{ name: string }> } }
    ).result?.tools?.map((t) => t.name) ?? [];
  }

  it("HT identity lists only HT tools", async () => {
    const db = threeTenantDb();
    const names = await listTools(
      envFor(db),
      serviceActor("co_ht", "HT Business ChatGPT", "mcp_ht_primary"),
    );
    expect(names.sort()).toEqual(withActionTools(["database_summary", "system_health"]));
    expect(names).not.toContain("search_company_knowledge");
  });

  it("EL identity lists only EL tools", async () => {
    const db = threeTenantDb();
    const names = await listTools(
      envFor(db),
      serviceActor("co_el", "EL Business ChatGPT", "mcp_el_primary"),
    );
    expect(names.sort()).toEqual(withActionTools(["system_health"]));
    expect(names).not.toContain("database_summary");
    expect(names).not.toContain("search_company_knowledge");
  });

  it("Caddington identity cannot see HT or EL tools", async () => {
    const db = threeTenantDb();
    const names = await listTools(
      envFor(db),
      serviceActor(
        "co_caddington",
        "Caddington Holdings ChatGPT",
        "mcp_caddington_primary",
      ),
    );
    expect(names.sort()).toEqual(
      withActionTools(["search", "search_company_knowledge", "system_health"]),
    );
    expect(names).not.toContain("database_summary");
    expect(names).not.toContain("fetch");
  });

  it("HT token cannot spoof EL or Caddington via params/header", async () => {
    const db = threeTenantDb();
    const env = envFor(db);
    const actor = serviceActor("co_ht", "HT Business ChatGPT", "mcp_ht_primary");

    const viaParams = await handleInfraMcpJsonRpc(
      env,
      new Request("https://infra.test/api/gateway/v1/mcp", { method: "POST" }),
      actor,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { companyId: "co_el" },
      },
    );
    expect(viaParams.httpStatus).toBe(403);
    expect(JSON.stringify(viaParams.payload)).toContain(
      "does not belong to this company",
    );

    const viaHeader = await handleInfraMcpJsonRpc(
      env,
      new Request("https://infra.test/api/gateway/v1/mcp", {
        method: "POST",
        headers: { "X-Infra-Company-Id": "co_caddington" },
      }),
      actor,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    );
    expect(viaHeader.httpStatus).toBe(403);
  });

  it("EL token cannot spoof HT", async () => {
    const db = threeTenantDb();
    const result = await handleInfraMcpJsonRpc(
      envFor(db),
      new Request("https://infra.test/api/gateway/v1/mcp", { method: "POST" }),
      serviceActor("co_el", "EL Business ChatGPT", "mcp_el_primary"),
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          companyId: "co_ht",
          name: "database_summary",
          arguments: {},
        },
      },
    );
    expect(result.httpStatus).toBe(403);
  });

  it("Caddington token cannot spoof HT", async () => {
    const db = threeTenantDb();
    const result = await handleInfraMcpJsonRpc(
      envFor(db),
      new Request("https://infra.test/api/gateway/v1/mcp", { method: "POST" }),
      serviceActor(
        "co_caddington",
        "Caddington Holdings ChatGPT",
        "mcp_caddington_primary",
      ),
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { companyId: "co_ht" },
      },
    );
    expect(result.httpStatus).toBe(403);
  });

  it("EL token cannot spoof Caddington via slug", async () => {
    const db = threeTenantDb();
    const result = await handleInfraMcpJsonRpc(
      envFor(db),
      new Request("https://infra.test/api/gateway/v1/mcp", { method: "POST" }),
      serviceActor("co_el", "EL Business ChatGPT", "mcp_el_primary"),
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { companySlug: "caddington-holdings" },
      },
    );
    expect(result.httpStatus).toBe(403);
  });

  it("Caddington token cannot spoof EL via MCP id", async () => {
    const db = threeTenantDb();
    const result = await handleInfraMcpJsonRpc(
      envFor(db),
      new Request("https://infra.test/api/gateway/v1/mcp", { method: "POST" }),
      serviceActor(
        "co_caddington",
        "Caddington Holdings ChatGPT",
        "mcp_caddington_primary",
      ),
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { mcpId: "mcp_el_primary" },
      },
    );
    expect(result.httpStatus).toBe(403);
  });

  it("HT token cannot spoof Caddington via tool arguments", async () => {
    const db = threeTenantDb();
    const result = await handleInfraMcpJsonRpc(
      envFor(db),
      new Request("https://infra.test/api/gateway/v1/mcp", { method: "POST" }),
      serviceActor("co_ht", "HT Business ChatGPT", "mcp_ht_primary"),
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "system_health",
          arguments: { companyId: "co_caddington" },
        },
      },
    );
    expect(result.httpStatus).toBe(403);
  });

  it("EL header slug cannot switch tenant to HT", async () => {
    const db = threeTenantDb();
    const result = await handleInfraMcpJsonRpc(
      envFor(db),
      new Request("https://infra.test/api/gateway/v1/mcp", {
        method: "POST",
        headers: { "X-Infra-Company-Slug": "ht-business" },
      }),
      serviceActor("co_el", "EL Business ChatGPT", "mcp_el_primary"),
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    );
    expect(result.httpStatus).toBe(403);
  });
});
