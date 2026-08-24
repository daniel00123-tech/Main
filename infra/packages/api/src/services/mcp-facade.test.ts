import { describe, expect, it } from "vitest";
import {
  enrichMcpToolDescription,
  handleInfraMcpJsonRpc,
  narrowKnowledgeSearchInputSchema,
  resolveMcpClientRequestId,
  sanitizeKnowledgeSearchArguments,
  wantsSse,
} from "./mcp-gateway";
import { extractServiceCredential } from "./gateway";
import type { Env } from "../env";

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
          }>;
        };
      }
    ).result?.tools;
    expect(tools?.map((t) => t.name).sort()).toEqual([
      "search_company_knowledge",
      "system_health",
    ]);
    expect(tools?.some((t) => t.name === "query_business_data")).toBe(false);
    const search = tools?.find((t) => t.name === "search_company_knowledge");
    expect(search?.description?.toLowerCase()).toContain("knowledge");
    expect(search?.inputSchema?.properties?.query).toBeTruthy();
    expect(search?.inputSchema?.properties?.topic).toBeUndefined();
  });
});
