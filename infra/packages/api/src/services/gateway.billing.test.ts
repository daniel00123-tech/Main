import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { executeGatewayRequest } from "./gateway";
import type { ServiceIdentityRecord } from "./service-identities";

const executeRegisteredMcpTool = vi.fn();

vi.mock("./control-plane", async () => {
  const actual = await vi.importActual<typeof import("./control-plane")>(
    "./control-plane",
  );
  return {
    ...actual,
    executeRegisteredMcpTool: (...args: unknown[]) =>
      executeRegisteredMcpTool(...args),
    ensureDefaultToolAllowlist: vi.fn().mockResolvedValue(undefined),
  };
});

type Row = Record<string, unknown>;

class FakeD1 {
  tables: Record<string, Row[]>;
  private harness: GatewayHarness;

  constructor(seed: Record<string, Row[]>) {
    this.tables = seed;
    this.harness = new GatewayHarness(this);
  }

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  first(sql: string, binds: unknown[]) {
    return this.harness.first(sql, binds);
  }

  all(sql: string, binds: unknown[]) {
    return this.harness.all(sql, binds);
  }

  run(sql: string, binds: unknown[]) {
    this.harness.run(sql, binds);
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
    this.db.run(this.sql, this.binds);
    return { success: true };
  }
}

class GatewayHarness {
  constructor(public db: FakeD1) {}

  first(sql: string, binds: unknown[]): Row | null {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.includes("from gateway_requests") && q.includes("client_request_id")) {
      return (
        this.db.tables.gateway_requests.find(
          (r) => r.company_id === binds[0] && r.client_request_id === binds[1],
        ) ?? null
      );
    }
    if (q.includes("from companies where id")) {
      return this.db.tables.companies.find((r) => r.id === binds[0]) ?? null;
    }
    if (q.includes("from mcp_environments where id")) {
      return this.db.tables.mcp_environments.find((r) => r.id === binds[0]) ?? null;
    }
    if (q.includes("from mcp_environments where company_id")) {
      return (
        this.db.tables.mcp_environments.find((r) => r.company_id === binds[0]) ??
        null
      );
    }
    if (q.includes("from mcp_tool_action_map")) {
      return (
        this.db.tables.mcp_tool_action_map.find(
          (r) => r.mcp_environment_id === binds[0] && r.tool_name === binds[1],
        ) ?? null
      );
    }
    if (q.includes("from permission_grants")) {
      return null;
    }
    if (q.includes("from pricing_policies") && q.includes("company_id =")) {
      return (
        this.db.tables.pricing_policies.find(
          (r) => r.company_id === binds[0] && Number(r.enabled) === 1,
        ) ?? null
      );
    }
    if (q.includes("from pricing_policies") && q.includes("company_id is null")) {
      return (
        this.db.tables.pricing_policies.find(
          (r) => r.company_id == null && Number(r.enabled) === 1,
        ) ?? null
      );
    }
    if (q.includes("from pricing_rules") && q.includes("company_id =")) {
      return (
        this.db.tables.pricing_rules.find(
          (r) =>
            Number(r.enabled) === 1 &&
            r.action === binds[0] &&
            r.company_id === binds[1],
        ) ?? null
      );
    }
    if (q.includes("from pricing_rules") && q.includes("company_id is null")) {
      return (
        this.db.tables.pricing_rules.find(
          (r) =>
            Number(r.enabled) === 1 &&
            r.action === binds[0] &&
            r.company_id == null,
        ) ?? null
      );
    }
    if (q.includes("from credit_balances")) {
      return this.db.tables.credit_balances.find((r) => r.company_id === binds[0]) ?? {
        company_id: binds[0],
        balance_cents: 0,
        currency: "GBP",
        updated_at: "t",
        low_balance_threshold_cents: 500,
      };
    }
    if (q.includes("sum(amount_cents)") && q.includes("ledger_entries")) {
      const total = this.db.tables.ledger_entries
        .filter((r) => r.company_id === binds[0])
        .reduce((sum, r) => sum + Number(r.amount_cents ?? 0), 0);
      return { total };
    }
    if (q.includes("from ledger_entries") && q.includes("reference_id")) {
      return (
        this.db.tables.ledger_entries.find(
          (r) =>
            r.company_id === binds[0] &&
            r.reference_type === binds[1] &&
            r.reference_id === binds[2],
        ) ?? null
      );
    }
    if (q.includes("from usage_records where request_id")) {
      return this.db.tables.usage_records.find((r) => r.request_id === binds[0]) ?? null;
    }
    if (q.includes("from usage_records where correlation_id")) {
      return (
        this.db.tables.usage_records.find((r) => r.correlation_id === binds[0]) ??
        null
      );
    }
    return null;
  }

  all(sql: string, binds: unknown[]): Row[] {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.includes("from mcp_environments where company_id")) {
      return this.db.tables.mcp_environments.filter((r) => r.company_id === binds[0]);
    }
    if (q.includes("from usage_records where interaction_id")) {
      return this.db.tables.usage_records
        .filter((r) => r.interaction_id === binds[0])
        .sort((a, b) => String(a.recorded_at).localeCompare(String(b.recorded_at)));
    }
    if (q.includes("from permission_grants")) {
      return [];
    }
    return [];
  }

  run(sql: string, binds: unknown[]) {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.startsWith("insert or ignore into credit_balances")) {
      if (!this.db.tables.credit_balances.some((r) => r.company_id === binds[0])) {
        this.db.tables.credit_balances.push({
          company_id: binds[0],
          balance_cents: 0,
          currency: binds[1],
          updated_at: binds[2],
          low_balance_threshold_cents: 500,
        });
      }
    }
    if (q.startsWith("insert into audit_events")) {
      this.db.tables.audit_events.push({ id: binds[0], company_id: binds[1] });
    }
    if (q.startsWith("insert into interactions")) {
      const existing = this.db.tables.interactions.find((r) => r.id === binds[0]);
      if (!existing) {
        this.db.tables.interactions.push({
          id: binds[0],
          company_id: binds[1],
          actor_type: binds[2],
          actor_id: binds[3],
          client_kind: binds[4],
          mcp_id: binds[5],
          mcp_session_id: binds[6],
          label: binds[7],
          customer_charge_cents: 0,
          operation_count: 0,
        });
      }
    }
    if (q.startsWith("update interactions")) {
      const row = this.db.tables.interactions.find((r) => r.id === binds[7]);
      if (row) {
        row.label = binds[0];
        row.status = binds[1];
        row.operation_count = binds[2];
        row.customer_charge_cents = binds[3];
        row.provider_cost_cents = binds[4];
        row.provider_cost_known = binds[5];
      }
    }
    if (q.startsWith("insert into usage_records")) {
      this.db.tables.usage_records.push({
        id: binds[0],
        company_id: binds[1],
        request_id: binds[21],
        correlation_id: binds[18],
        interaction_id: binds[35],
        customer_charge_cents: binds[20],
        underlying_cost_cents: binds[19],
        cost_basis: binds[22],
        action: binds[13],
        tool_name: binds[12],
        success: binds[15],
        recorded_at: binds[6],
      });
    }
    if (q.startsWith("insert into ledger_entries")) {
      this.db.tables.ledger_entries.push({
        id: binds[0],
        company_id: binds[1],
        entry_type: binds[2],
        amount_cents: binds[3],
        reference_type: binds[7],
        reference_id: binds[8],
        metadata_json: binds[10],
      });
    }
    if (q.startsWith("update usage_records") && q.includes("settled")) {
      const row = this.db.tables.usage_records.find((r) => r.id === binds[1]);
      if (row) row.ledger_entry_id = binds[0];
    }
    if (q.startsWith("insert into gateway_requests")) {
      const n = binds.length;
      this.db.tables.gateway_requests.push({
        id: binds[0],
        company_id: binds[2],
        client_request_id: binds[n - 6],
        request_id: binds[n - 5],
        http_status: q.includes("insufficient_credit") ? 402 : 200,
        status: q.includes("denied")
          ? "denied"
          : q.includes("insufficient_credit")
            ? "insufficient_credit"
            : "succeeded",
        mcp_environment_id: binds[7],
        tool_name: binds[8],
        action: binds[9],
        latency_ms: 1,
        ledger_entry_id: q.includes("usage_record_id") ? binds[16] : null,
        correlation_id: binds[1],
        interaction_id: binds[n - 3],
      });
    }
    if (q.startsWith("update credit_balances")) {
      const row = this.db.tables.credit_balances.find((r) => r.company_id === binds[binds.length - 1]);
      if (row && binds[0] != null) row.balance_cents = binds[0];
    }
  }
}

function seedDb(balance = 1000) {
  const db = new FakeD1({
    companies: [{ id: "co_ht", status: "active", slug: "ht-business", name: "HT" }],
    mcp_environments: [
      {
        id: "mcp_ht_primary",
        company_id: "co_ht",
        name: "HT",
        endpoint_url: "https://ht.example/mcp",
        enabled: 1,
        status: "healthy",
        created_at: "t",
        updated_at: "t",
      },
    ],
    mcp_tool_action_map: [],
    mcp_tool_allowlist: [],
    permission_grants: [],
    pricing_policies: [
      {
        id: "pol",
        company_id: null,
        enabled: 1,
        target_margin_bps: 6000,
        minimum_charge_cents: 1,
        currency: "GBP",
        is_test_config: 1,
        label: "TEST",
        effective_from: "2020-01-01",
        margin_basis: "gross_margin",
      },
    ],
    pricing_rules: [
      {
        id: "rule_search",
        company_id: null,
        action: "knowledge.search",
        pricing_mode: "fixed",
        fixed_charge_cents: 1,
        is_billable: 1,
        charge_on_failure: 0,
        enabled: 1,
        is_test_config: 1,
        minimum_charge_cents: 1,
        label: "TEST search 1p",
      },
      {
        id: "rule_read",
        company_id: null,
        action: "knowledge.read",
        pricing_mode: "fixed",
        fixed_charge_cents: 1,
        is_billable: 1,
        charge_on_failure: 0,
        enabled: 1,
        is_test_config: 1,
        minimum_charge_cents: 1,
        label: "TEST read 1p",
      },
      {
        id: "rule_health",
        company_id: null,
        action: "system.health",
        pricing_mode: "free",
        fixed_charge_cents: 0,
        is_billable: 0,
        charge_on_failure: 0,
        enabled: 1,
        is_test_config: 1,
        minimum_charge_cents: 0,
        label: "health free",
      },
    ],
    credit_balances: [
      {
        company_id: "co_ht",
        balance_cents: balance,
        currency: "GBP",
        updated_at: "t",
        low_balance_threshold_cents: 500,
      },
    ],
    ledger_entries: [
      {
        id: "ledger_open",
        company_id: "co_ht",
        amount_cents: balance,
        entry_type: "promotional_credit",
      },
    ],
    usage_records: [],
    gateway_requests: [],
    interactions: [],
    audit_events: [],
  });
  return db;
}

function identity(): ServiceIdentityRecord {
  return {
    id: "svc_ht",
    companyId: "co_ht",
    name: "HT probe",
    description: null,
    identityType: "other",
    status: "active",
    tokenPrefix: "infra_test",
    hasToken: true,
    scopes: ["knowledge.search", "knowledge.read", "system.health"],
    mcpEnvironmentId: "mcp_ht_primary",
    lastUsedAt: null,
    requestCount: 0,
    createdAt: "t",
    updatedAt: "t",
  };
}

function env(db: FakeD1): Env {
  return {
    DB: db as unknown as D1Database,
    ENVIRONMENT: "test",
    SESSION_SECRET: "x",
    ALLOWED_ORIGINS: "*",
  } as Env;
}

describe("gateway billing and idempotency", () => {
  beforeEach(() => {
    executeRegisteredMcpTool.mockReset();
    executeRegisteredMcpTool.mockResolvedValue({
      status: 200,
      data: { result: { content: [{ type: "text", text: "{}" }] } },
    });
  });

  it("charges a successful billable search once", async () => {
    const db = seedDb();
    const result = await executeGatewayRequest(env(db), {
      actor: { type: "service", identity: identity() },
      companyId: "co_ht",
      toolName: "search_company_knowledge",
      arguments: { query: "falcon" },
      clientRequestId: "call-search-1",
      interactionId: "int_turn_aaaa",
    });
    expect(result.status).toBe(200);
    expect(db.tables.ledger_entries.filter((r) => r.entry_type === "usage_debit")).toHaveLength(1);
    expect(db.tables.usage_records).toHaveLength(1);
    expect(db.tables.interactions[0]?.id).toBe("int_turn_aaaa");
  });

  it("does not charge a replay of the same client request", async () => {
    const db = seedDb();
    const input = {
      actor: { type: "service" as const, identity: identity() },
      companyId: "co_ht",
      toolName: "search_company_knowledge",
      arguments: { query: "falcon" },
      clientRequestId: "call-replay",
      interactionId: "int_turn_bbbb",
    };
    await executeGatewayRequest(env(db), input);
    const second = await executeGatewayRequest(env(db), input);
    expect(second.idempotentReplay).toBe(true);
    expect(db.tables.ledger_entries.filter((r) => r.entry_type === "usage_debit")).toHaveLength(1);
    expect(executeRegisteredMcpTool).toHaveBeenCalledTimes(1);
  });

  it("charges two different operations in one interaction", async () => {
    const db = seedDb();
    await executeGatewayRequest(env(db), {
      actor: { type: "service", identity: identity() },
      companyId: "co_ht",
      toolName: "search_company_knowledge",
      arguments: { query: "falcon" },
      clientRequestId: "op-search",
      interactionId: "int_turn_cccc",
    });
    await executeGatewayRequest(env(db), {
      actor: { type: "service", identity: identity() },
      companyId: "co_ht",
      toolName: "get_knowledge_document",
      arguments: { id: "doc_1" },
      clientRequestId: "op-read",
      interactionId: "int_turn_cccc",
    });
    expect(db.tables.ledger_entries.filter((r) => r.entry_type === "usage_debit")).toHaveLength(2);
    expect(db.tables.usage_records).toHaveLength(2);
    expect(new Set(db.tables.usage_records.map((r) => r.interaction_id))).toEqual(
      new Set(["int_turn_cccc"]),
    );
  });

  it("keeps concurrent interactions separate when ids differ", async () => {
    const db = seedDb();
    await Promise.all([
      executeGatewayRequest(env(db), {
        actor: { type: "service", identity: identity() },
        companyId: "co_ht",
        toolName: "search_company_knowledge",
        arguments: { query: "one" },
        clientRequestId: "conc-a",
        interactionId: "int_conc_aaa",
      }),
      executeGatewayRequest(env(db), {
        actor: { type: "service", identity: identity() },
        companyId: "co_ht",
        toolName: "search_company_knowledge",
        arguments: { query: "two" },
        clientRequestId: "conc-b",
        interactionId: "int_conc_bbb",
      }),
    ]);
    expect(db.tables.usage_records.map((r) => r.interaction_id).sort()).toEqual([
      "int_conc_aaa",
      "int_conc_bbb",
    ]);
    expect(db.tables.ledger_entries.filter((r) => r.entry_type === "usage_debit")).toHaveLength(2);
  });

  it("does not charge a failed downstream call", async () => {
    executeRegisteredMcpTool.mockResolvedValue({
      status: 502,
      error: "downstream failed",
    });
    const db = seedDb();
    const result = await executeGatewayRequest(env(db), {
      actor: { type: "service", identity: identity() },
      companyId: "co_ht",
      toolName: "search_company_knowledge",
      arguments: { query: "falcon" },
      clientRequestId: "fail-1",
    });
    expect(result.status).toBe(502);
    expect(db.tables.ledger_entries.filter((r) => r.entry_type === "usage_debit")).toHaveLength(0);
  });

  it("does not charge health checks", async () => {
    const db = seedDb();
    const result = await executeGatewayRequest(env(db), {
      actor: { type: "service", identity: identity() },
      companyId: "co_ht",
      toolName: "system_health",
      clientRequestId: "health-1",
    });
    expect(result.status).toBe(200);
    expect(db.tables.ledger_entries.filter((r) => r.entry_type === "usage_debit")).toHaveLength(0);
  });

  it("does not charge insufficient credit and does not call downstream", async () => {
    const db = seedDb(0);
    db.tables.ledger_entries = [];
    db.tables.credit_balances[0]!.balance_cents = 0;
    const result = await executeGatewayRequest(env(db), {
      actor: { type: "service", identity: identity() },
      companyId: "co_ht",
      toolName: "search_company_knowledge",
      arguments: { query: "falcon" },
      clientRequestId: "nocredit",
    });
    expect(result.status).toBe(402);
    expect(executeRegisteredMcpTool).not.toHaveBeenCalled();
    expect(db.tables.ledger_entries.filter((r) => r.entry_type === "usage_debit")).toHaveLength(0);
  });

  it("same JSON-RPC id 0 is not an idempotency key — two calls still charge twice", async () => {
    const db = seedDb();
    await executeGatewayRequest(env(db), {
      actor: { type: "service", identity: identity() },
      companyId: "co_ht",
      toolName: "search_company_knowledge",
      arguments: { query: "one" },
      clientRequestId: null,
    });
    await executeGatewayRequest(env(db), {
      actor: { type: "service", identity: identity() },
      companyId: "co_ht",
      toolName: "search_company_knowledge",
      arguments: { query: "two" },
      clientRequestId: null,
    });
    expect(db.tables.ledger_entries.filter((r) => r.entry_type === "usage_debit")).toHaveLength(2);
  });
});
