import { describe, expect, it } from "vitest";
import type { UsageRecord } from "@infra/shared";
import {
  isLiveElBillingEnv,
  CHATGPT_TOOL_BURST_MS,
  EL_COMPANY_ID,
  EL_CUSTOMER_REQUEST_ACTION,
  EL_CUSTOMER_REQUEST_PRICE_CENTS,
  EL_PRICING_POLICY_ID,
  EL_PRICING_RULE_ID,
  channelFromSourceClient,
  classifyElTraffic,
  isElChildUsageRow,
  isElCompany,
  recordElChildUsage,
  resolveElCustomerRequestId,
  settleElCustomerRequest,
  shouldChargeElCustomerRequest,
  usageRequestIdForElRequest,
} from "./el-customer-billing";
import { groupOperationsIntoInteractions } from "./interactions";
import { ensureElCustomerPricing } from "./el-customer-billing";

type Row = Record<string, unknown>;

class FakeD1 {
  tables: Record<string, Row[]> = {
    pricing_policies: [],
    pricing_rules: [],
    usage_records: [],
    ledger_entries: [
      { id: "ledger_open", company_id: EL_COMPANY_ID, amount_cents: 10_000, entry_type: "promotional_credit" },
    ],
    credit_balances: [
      {
        company_id: EL_COMPANY_ID,
        balance_cents: 10_000,
        currency: "GBP",
        updated_at: "t",
        low_balance_threshold_cents: 500,
      },
    ],
    interactions: [],
    el_customer_requests: [],
    promotional_credit_grants: [],
  };

  prepare(sql: string) {
    return new FakeStatement(this, sql);
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
    const rows = this.allRows();
    return rows[0] ?? null;
  }

  async all() {
    return { results: this.allRows() };
  }

  async run() {
    this.execute();
    return { success: true };
  }

  private q() {
    return this.sql.replace(/\s+/g, " ").trim().toLowerCase();
  }

  private allRows(): Row[] {
    const q = this.q();
    const b = this.binds;
    if (q.includes("from pricing_policies") && q.includes("id =")) {
      return this.db.tables.pricing_policies.filter((r) => r.id === b[0]);
    }
    if (q.includes("from pricing_policies") && q.includes("company_id =")) {
      return this.db.tables.pricing_policies.filter((r) => r.company_id === b[0] && Number(r.enabled) === 1);
    }
    if (q.includes("from pricing_policies") && q.includes("company_id is null")) {
      return this.db.tables.pricing_policies.filter((r) => r.company_id == null && Number(r.enabled) === 1);
    }
    if (q.includes("from pricing_rules") && q.includes("company_id =")) {
      return this.db.tables.pricing_rules.filter(
        (r) => Number(r.enabled) === 1 && r.action === b[0] && r.company_id === b[1],
      );
    }
    if (q.includes("from pricing_rules") && q.includes("company_id is null")) {
      return this.db.tables.pricing_rules.filter(
        (r) => Number(r.enabled) === 1 && r.action === b[0] && r.company_id == null,
      );
    }
    if (q.includes("from usage_records where request_id")) {
      return this.db.tables.usage_records.filter((r) => r.request_id === b[0]);
    }
    if (q.includes("from usage_records where correlation_id")) {
      return this.db.tables.usage_records.filter((r) => r.correlation_id === b[0]);
    }
    if (q.includes("from usage_records where interaction_id")) {
      return this.db.tables.usage_records.filter((r) => r.interaction_id === b[0]);
    }
    if (q.includes("from credit_balances")) {
      return this.db.tables.credit_balances.filter((r) => r.company_id === b[0]);
    }
    if (q.includes("sum(amount_cents)") && q.includes("ledger_entries")) {
      const total = this.db.tables.ledger_entries
        .filter((r) => r.company_id === b[0])
        .reduce((sum, r) => sum + Number(r.amount_cents ?? 0), 0);
      return [{ total }];
    }
    if (q.includes("from ledger_entries") && q.includes("reference_id")) {
      return this.db.tables.ledger_entries.filter(
        (r) => r.company_id === b[0] && r.reference_type === b[1] && r.reference_id === b[2],
      );
    }
    if (q.includes("from promotional_credit_grants")) {
      return [];
    }
    if (q.includes("from el_customer_requests") && q.includes("conversation_id")) {
      return this.db.tables.el_customer_requests
        .filter(
          (r) =>
            r.company_id === b[0] &&
            r.channel === "chatgpt" &&
            r.conversation_id === b[1] &&
            (b[2] == null || r.user_id === b[3]),
        )
        .sort((a, c) => String(c.last_activity_at).localeCompare(String(a.last_activity_at)));
    }
    return [];
  }

  private execute() {
    const q = this.q();
    const b = this.binds;
    if (q.startsWith("create table")) return;
    if (q.startsWith("insert or ignore into pricing_policies")) {
      if (!this.db.tables.pricing_policies.some((r) => r.id === b[0])) {
        this.db.tables.pricing_policies.push({
          id: b[0],
          company_id: b[1],
          target_margin_bps: 6000,
          minimum_charge_cents: b[2],
          currency: "GBP",
          is_test_config: 0,
          enabled: 1,
          label: b[3],
          effective_from: b[4],
        });
      }
      return;
    }
    if (q.startsWith("insert or ignore into pricing_rules")) {
      if (!this.db.tables.pricing_rules.some((r) => r.id === b[0])) {
        this.db.tables.pricing_rules.push({
          id: b[0],
          company_id: b[1],
          action: b[2],
          pricing_mode: "fixed",
          fixed_charge_cents: b[3],
          minimum_charge_cents: b[4],
          charge_on_failure: 1,
          is_billable: 1,
          enabled: 1,
          label: b[5],
          is_test_config: 0,
        });
      }
      return;
    }
    if (q.startsWith("insert or ignore into credit_balances")) {
      if (!this.db.tables.credit_balances.some((r) => r.company_id === b[0])) {
        this.db.tables.credit_balances.push({
          company_id: b[0],
          balance_cents: 0,
          currency: "GBP",
          updated_at: "t",
          low_balance_threshold_cents: 500,
        });
      }
      return;
    }
    if (q.startsWith("insert into usage_records")) {
      this.db.tables.usage_records.push({
        id: b[0],
        company_id: b[1],
        resource_type: b[2],
        resource_id: b[3],
        quantity: b[4],
        unit: b[5],
        recorded_at: b[6],
        metadata_json: b[7],
        user_id: b[8],
        actor_email: b[9],
        tool_name: b[12],
        action: b[13],
        success: b[15],
        source_client: b[17],
        correlation_id: b[18],
        underlying_cost_cents: b[19],
        customer_charge_cents: b[20],
        request_id: b[21],
        ledger_entry_id: b[33],
        settlement_status: b[34],
        interaction_id: b[35],
        parent_request_id: b[36],
      });
      return;
    }
    if (q.startsWith("insert into ledger_entries")) {
      this.db.tables.ledger_entries.push({
        id: b[0],
        company_id: b[1],
        entry_type: b[2],
        amount_cents: b[3],
        currency: b[4],
        balance_after_cents: b[5],
        reference_type: b[6],
        reference_id: b[7],
        description: b[8],
        metadata_json: b[9],
        created_by: b[10],
        created_at: b[11],
      });
      return;
    }
    if (q.startsWith("update credit_balances")) {
      const row = this.db.tables.credit_balances.find((r) => r.company_id === b[2]);
      if (row) row.balance_cents = b[0];
      return;
    }
    if (q.startsWith("update usage_records") && q.includes("settlement_status")) {
      const row = this.db.tables.usage_records.find((r) => r.id === b[1]);
      if (row) {
        row.settlement_status = "settled";
        row.ledger_entry_id = b[0];
      }
      return;
    }
    if (q.startsWith("insert into interactions") || q.startsWith("insert into interactions")) {
      this.db.tables.interactions.push({ id: b[0], company_id: b[1] });
      return;
    }
    if (q.startsWith("update interactions")) return;
    if (q.startsWith("insert into el_customer_requests")) {
      const existing = this.db.tables.el_customer_requests.find((r) => r.id === b[0]);
      if (existing) {
        existing.last_activity_at = b[14];
        if (Number(b[9]) === 1) existing.settled = 1;
        return;
      }
      this.db.tables.el_customer_requests.push({
        id: b[0],
        company_id: b[1],
        user_id: b[2],
        channel: b[4],
        conversation_id: b[5],
        traffic_class: b[7],
        settled: b[9],
        last_activity_at: b[14],
      });
      return;
    }
    if (q.startsWith("update el_customer_requests")) {
      const row = this.db.tables.el_customer_requests.find((r) => r.id === b[1]);
      if (row) row.last_activity_at = b[0];
    }
  }
}

function db(balance = 10_000) {
  const fake = new FakeD1();
  fake.tables.ledger_entries[0]!.amount_cents = balance;
  fake.tables.credit_balances[0]!.balance_cents = balance;
  fake.tables.pricing_rules.push({
    id: "price_knowledge_search",
    company_id: null,
    action: "knowledge.search",
    pricing_mode: "fixed",
    fixed_charge_cents: 1,
    is_billable: 1,
    charge_on_failure: 0,
    enabled: 1,
    is_test_config: 1,
    minimum_charge_cents: 1,
  });
  return fake as unknown as D1Database & { tables: FakeD1["tables"] };
}

function usage(partial: Partial<UsageRecord> & Pick<UsageRecord, "id">): UsageRecord {
  return {
    companyId: EL_COMPANY_ID,
    resourceType: "gateway",
    resourceId: null,
    quantity: 1,
    unit: "request",
    recordedAt: "2026-09-04T12:00:00.000Z",
    metadata: {},
    success: true,
    customerChargeCents: null,
    costBasis: "unknown",
    ...partial,
  };
}

describe("EL traffic classification", () => {
  it("classifies genuine interactive channels as CUSTOMER_REQUEST", () => {
    expect(classifyElTraffic({ sourceClient: "whatsapp" })).toBe("CUSTOMER_REQUEST");
    expect(classifyElTraffic({ sourceClient: "portal_chat" })).toBe("CUSTOMER_REQUEST");
    expect(classifyElTraffic({ sourceClient: "chatgpt" })).toBe("CUSTOMER_REQUEST");
    expect(isLiveElBillingEnv({ ENVIRONMENT: "production" })).toBe(true);
    expect(isLiveElBillingEnv({ ENVIRONMENT: "test" })).toBe(false);
  });

  it("does not charge test, shadow, quality, internal, automation, or health traffic", () => {
    expect(classifyElTraffic({ userAgent: "InfraAcceptance/1.0" })).toBe("TEST");
    expect(classifyElTraffic({ wamid: "wamid.uat.1" })).toBe("TEST");
    expect(classifyElTraffic({ shadow: true })).toBe("SHADOW");
    expect(classifyElTraffic({ sourceClient: "quality_loop" })).toBe("QUALITY");
    expect(classifyElTraffic({ sourceClient: "automation-engine" })).toBe("AUTOMATION");
    expect(classifyElTraffic({ sourceClient: "health" })).toBe("HEALTH");
    expect(classifyElTraffic({ skipUsageRecording: true })).toBe("INTERNAL");
    expect(shouldChargeElCustomerRequest(EL_COMPANY_ID, "TEST")).toBe(false);
    expect(shouldChargeElCustomerRequest("co_caddington", "CUSTOMER_REQUEST")).toBe(false);
    expect(isElCompany("co_ht")).toBe(false);
  });
});

describe("EL 3p customer-request settlement", () => {
  it("charges exactly 3p once per genuine request", async () => {
    const database = db();
    const first = await settleElCustomerRequest(database, {
      companyId: EL_COMPANY_ID,
      requestId: "creq_portal_xero_1",
      userId: "usr_ella",
      actorEmail: "ella@elvexpropertyservices.com",
      sourceClient: "portal_chat",
      outcome: "completed",
      summary: "Xero sales this month",
    });
    expect(first.charged).toBe(true);
    expect(first.customerChargeCents).toBe(3);
    expect(first.balanceAfterCents).toBe((first.balanceBeforeCents ?? 0) - 3);
    const replay = await settleElCustomerRequest(database, {
      companyId: EL_COMPANY_ID,
      requestId: "creq_portal_xero_1",
      sourceClient: "portal_chat",
    });
    expect(replay.alreadySettled).toBe(true);
    expect(replay.charged).toBe(false);
    expect(database.tables.ledger_entries.filter((r) => r.entry_type === "usage_debit")).toHaveLength(1);
  });

  it("does not charge other tenants", async () => {
    const database = db();
    const result = await settleElCustomerRequest(database, {
      companyId: "co_caddington",
      requestId: "creq_cadd_1",
      sourceClient: "portal_chat",
    });
    expect(result.skipped).toBe(true);
    expect(database.tables.ledger_entries.filter((r) => r.entry_type === "usage_debit")).toHaveLength(0);
  });

  it("does not charge TEST / SHADOW / QUALITY / INTERNAL / AUTOMATION / HEALTH", async () => {
    const database = db();
    for (const trafficClass of ["TEST", "SHADOW", "QUALITY", "INTERNAL", "AUTOMATION", "HEALTH"] as const) {
      const result = await settleElCustomerRequest(database, {
        companyId: EL_COMPANY_ID,
        requestId: `creq_${trafficClass.toLowerCase()}`,
        sourceClient: "whatsapp",
        trafficClass,
      });
      expect(result.charged).toBe(false);
      expect(result.skipped).toBe(true);
    }
    expect(database.tables.ledger_entries.filter((r) => r.entry_type === "usage_debit")).toHaveLength(0);
  });

  it("still charges denied, no-result, and processed provider failure", async () => {
    const database = db();
    for (const [id, outcome] of [
      ["creq_denied", "permission_denied"],
      ["creq_empty", "no_result"],
      ["creq_fail", "upstream_failure"],
    ] as const) {
      const result = await settleElCustomerRequest(database, {
        companyId: EL_COMPANY_ID,
        requestId: id,
        sourceClient: "chatgpt",
        outcome,
      });
      expect(result.charged).toBe(true);
      expect(result.customerChargeCents).toBe(3);
    }
  });

  it("blocks when the wallet cannot cover 3p", async () => {
    const database = db(2);
    const result = await settleElCustomerRequest(database, {
      companyId: EL_COMPANY_ID,
      requestId: "creq_nocredit",
      sourceClient: "portal_chat",
    });
    expect(result.insufficientCredit).toBe(true);
    expect(result.charged).toBe(false);
    expect(database.tables.ledger_entries.filter((r) => r.entry_type === "usage_debit")).toHaveLength(0);
  });

  it("records child tool rows without extra debit", async () => {
    const database = db();
    await settleElCustomerRequest(database, {
      companyId: EL_COMPANY_ID,
      requestId: "creq_multi",
      sourceClient: "whatsapp",
    });
    await recordElChildUsage(database, {
      companyId: EL_COMPANY_ID,
      parentRequestId: "creq_multi",
      sourceClient: "whatsapp",
      toolName: "xero_sales_summary",
      action: "xero.sales.summary",
      requestId: "req_child_xero",
    });
    await recordElChildUsage(database, {
      companyId: EL_COMPANY_ID,
      parentRequestId: "creq_multi",
      sourceClient: "whatsapp",
      toolName: "outlook_list_messages",
      action: "outlook.mail.read",
      requestId: "req_child_outlook",
    });
    await recordElChildUsage(database, {
      companyId: EL_COMPANY_ID,
      parentRequestId: "creq_multi",
      sourceClient: "whatsapp",
      toolName: "search_company_knowledge",
      action: "knowledge.search",
      requestId: "req_child_knowledge",
    });
    const debits = database.tables.ledger_entries.filter((r) => r.entry_type === "usage_debit");
    expect(debits).toHaveLength(1);
    expect(debits[0]?.amount_cents).toBe(-3);
    expect(
      database.tables.usage_records.filter((r) => r.parent_request_id === "creq_multi" && r.action !== EL_CUSTOMER_REQUEST_ACTION),
    ).toHaveLength(3);
    expect(
      database.tables.usage_records
        .filter((r) => r.action !== EL_CUSTOMER_REQUEST_ACTION)
        .every((r) => r.customer_charge_cents == null),
    ).toBe(true);
  });
});

describe("30-scenario EL billing campaign", () => {
  const scenarios: Array<{
    id: string;
    sourceClient: string;
    trafficClass?: string;
    tools?: string[];
    outcome?: "completed" | "no_result" | "permission_denied" | "upstream_failure";
    expectCharge: boolean;
    reuseId?: string;
  }> = [
    { id: "s01", sourceClient: "portal_chat", tools: ["xero_sales_summary"], expectCharge: true },
    { id: "s02", sourceClient: "portal_chat", tools: ["outlook_list_messages"], expectCharge: true },
    { id: "s03", sourceClient: "portal_chat", tools: ["search_company_knowledge"], expectCharge: true },
    { id: "s04", sourceClient: "portal_chat", tools: [], expectCharge: true },
    { id: "s05", sourceClient: "portal_chat", tools: ["web_search"], expectCharge: true },
    { id: "s06", sourceClient: "whatsapp", tools: ["xero_sales_summary"], expectCharge: true },
    { id: "s07", sourceClient: "whatsapp", tools: ["outlook_list_messages"], expectCharge: true },
    { id: "s08", sourceClient: "whatsapp", tools: ["search_company_knowledge"], expectCharge: true },
    { id: "s09", sourceClient: "whatsapp", tools: ["web_search"], expectCharge: true },
    { id: "s10", sourceClient: "whatsapp", tools: ["xero_sales_summary"], expectCharge: true },
    { id: "s11", sourceClient: "chatgpt", tools: ["xero_sales_summary"], expectCharge: true },
    { id: "s12", sourceClient: "chatgpt", tools: ["outlook_list_messages"], expectCharge: true },
    { id: "s13", sourceClient: "chatgpt", tools: ["search_company_knowledge"], expectCharge: true },
    { id: "s14", sourceClient: "portal_chat", tools: ["xero_sales_summary", "outlook_list_messages"], expectCharge: true },
    {
      id: "s15",
      sourceClient: "whatsapp",
      tools: ["xero_sales_summary", "outlook_list_messages", "search_company_knowledge"],
      expectCharge: true,
    },
    { id: "s16", sourceClient: "portal_chat", tools: ["openai_primary"], expectCharge: true },
    { id: "s17", sourceClient: "whatsapp", tools: ["openai_fallback"], expectCharge: true },
    { id: "s18", sourceClient: "portal_chat", trafficClass: "SHADOW", tools: ["openai_shadow"], expectCharge: false },
    { id: "s19", sourceClient: "chatgpt", outcome: "permission_denied", expectCharge: true },
    { id: "s20", sourceClient: "portal_chat", outcome: "no_result", expectCharge: true },
    { id: "s21", sourceClient: "whatsapp", outcome: "upstream_failure", expectCharge: true },
    { id: "s22", sourceClient: "whatsapp", reuseId: "s06", expectCharge: false },
    { id: "s23", sourceClient: "whatsapp", reuseId: "s15", tools: ["xero_sales_summary"], expectCharge: false },
    { id: "s24", sourceClient: "portal_chat", reuseId: "s16", tools: ["openai_retry"], expectCharge: false },
    { id: "s25", sourceClient: "whatsapp", reuseId: "s06", tools: ["quality_resynth"], expectCharge: false },
    { id: "s26", sourceClient: "whatsapp", trafficClass: "TEST", expectCharge: false },
    { id: "s27", sourceClient: "health", trafficClass: "HEALTH", expectCharge: false },
    { id: "s28", sourceClient: "automation-engine", trafficClass: "AUTOMATION", expectCharge: false },
    { id: "s29", sourceClient: "automation-knowledge-ingestion", trafficClass: "INTERNAL", expectCharge: false },
    { id: "s30", sourceClient: "whatsapp", reuseId: "s07", expectCharge: false },
  ];

  it("charges only genuine customer requests and never double-charges children or retries", async () => {
    const database = db();
    let expected = 0;
    for (const scenario of scenarios) {
      const requestId = `creq_${scenario.reuseId ?? scenario.id}`;
      const result = await settleElCustomerRequest(database, {
        companyId: EL_COMPANY_ID,
        requestId,
        sourceClient: scenario.sourceClient,
        trafficClass: scenario.trafficClass,
        outcome: scenario.outcome ?? "completed",
      });
      if (scenario.expectCharge) {
        expect(result.charged, scenario.id).toBe(true);
        expected += 3;
      } else {
        expect(result.charged, scenario.id).toBe(false);
      }
      for (const [index, tool] of (scenario.tools ?? []).entries()) {
        await recordElChildUsage(database, {
          companyId: EL_COMPANY_ID,
          parentRequestId: requestId,
          sourceClient: scenario.sourceClient,
          toolName: tool,
          action: tool,
          requestId: `req_${scenario.id}_${index}`,
        });
      }
    }
    const debits = database.tables.ledger_entries.filter((r) => r.entry_type === "usage_debit");
    expect(debits).toHaveLength(20);
    expect(debits.reduce((sum, row) => sum + Number(row.amount_cents), 0)).toBe(-expected);
    expect(expected).toBe(60);
  });
});

describe("reconciliation", () => {
  it("debits £0.30 for 10 genuine requests and nothing for their children", async () => {
    const database = db();
    const before = 10_000;
    for (let i = 0; i < 10; i += 1) {
      await settleElCustomerRequest(database, {
        companyId: EL_COMPANY_ID,
        requestId: `creq_recon_${i}`,
        sourceClient: i % 2 === 0 ? "portal_chat" : "whatsapp",
      });
      await recordElChildUsage(database, {
        companyId: EL_COMPANY_ID,
        parentRequestId: `creq_recon_${i}`,
        sourceClient: "portal_chat",
        toolName: "xero_sales_summary",
        action: "xero.sales.summary",
        requestId: `req_recon_child_${i}`,
      });
    }
    const debit = database.tables.ledger_entries
      .filter((r) => r.entry_type === "usage_debit")
      .reduce((sum, row) => sum + Number(row.amount_cents), 0);
    expect(debit).toBe(-30);
    const after = database.tables.ledger_entries.reduce((sum, row) => sum + Number(row.amount_cents), 0);
    expect(before + debit).toBe(after);
  });

  it("debits £0.45 across 5 portal + 5 WhatsApp + 5 ChatGPT requests", async () => {
    const database = db();
    const channels = [
      ...Array.from({ length: 5 }, () => "portal_chat"),
      ...Array.from({ length: 5 }, () => "whatsapp"),
      ...Array.from({ length: 5 }, () => "chatgpt"),
    ];
    for (const [index, sourceClient] of channels.entries()) {
      await settleElCustomerRequest(database, {
        companyId: EL_COMPANY_ID,
        requestId: `creq_cross_${index}`,
        sourceClient,
        userId: "usr_ella",
      });
    }
    const debit = database.tables.ledger_entries
      .filter((r) => r.entry_type === "usage_debit")
      .reduce((sum, row) => sum + Number(row.amount_cents), 0);
    expect(debit).toBe(-45);
    const byChannel = Object.fromEntries(
      ["portal_chat", "whatsapp", "chatgpt"].map((channel) => [
        channel,
        database.tables.usage_records.filter(
          (r) => r.action === EL_CUSTOMER_REQUEST_ACTION && r.source_client === channel,
        ).length,
      ]),
    );
    expect(byChannel).toEqual({ portal_chat: 5, whatsapp: 5, chatgpt: 5 });
  });
});

describe("ChatGPT turn grouping", () => {
  it("reuses one request id across a tool burst and opens a new turn after idle", async () => {
    const database = db();
    const first = await resolveElCustomerRequestId(database, {
      companyId: EL_COMPANY_ID,
      userId: "usr_ella",
      sourceClient: "chatgpt",
      conversationId: "conv_1",
      trafficClass: "CUSTOMER_REQUEST",
      nowMs: 1_000_000,
    });
    const second = await resolveElCustomerRequestId(database, {
      companyId: EL_COMPANY_ID,
      userId: "usr_ella",
      sourceClient: "chatgpt",
      conversationId: "conv_1",
      trafficClass: "CUSTOMER_REQUEST",
      nowMs: 1_000_000 + 5_000,
    });
    const later = await resolveElCustomerRequestId(database, {
      companyId: EL_COMPANY_ID,
      userId: "usr_ella",
      sourceClient: "chatgpt",
      conversationId: "conv_1",
      trafficClass: "CUSTOMER_REQUEST",
      nowMs: 1_000_000 + 5_000 + CHATGPT_TOOL_BURST_MS + 1,
    });
    expect(second.requestId).toBe(first.requestId);
    expect(second.reused).toBe(true);
    expect(later.requestId).not.toBe(first.requestId);
  });

  it("does not merge two concurrent conversations", async () => {
    const database = db();
    const a = await resolveElCustomerRequestId(database, {
      companyId: EL_COMPANY_ID,
      userId: "usr_ella",
      sourceClient: "chatgpt",
      conversationId: "conv_a",
      trafficClass: "CUSTOMER_REQUEST",
      nowMs: 1_000_000,
    });
    const b = await resolveElCustomerRequestId(database, {
      companyId: EL_COMPANY_ID,
      userId: "usr_ella",
      sourceClient: "chatgpt",
      conversationId: "conv_b",
      trafficClass: "CUSTOMER_REQUEST",
      nowMs: 1_000_000,
    });
    expect(a.requestId).not.toBe(b.requestId);
  });
});

describe("usage grouping and policy", () => {
  it("groups parent + children as one £0.03 commercial line", () => {
    const groups = groupOperationsIntoInteractions([
      usage({
        id: "u0",
        action: EL_CUSTOMER_REQUEST_ACTION,
        customerChargeCents: 3,
        interactionId: "creq_ui",
        parentRequestId: "creq_ui",
        sourceClient: "portal_chat",
      }),
      usage({
        id: "u1",
        action: "knowledge.search",
        interactionId: "creq_ui",
        parentRequestId: "creq_ui",
        customerChargeCents: null,
      }),
      usage({
        id: "u2",
        action: "xero.sales.summary",
        interactionId: "creq_ui",
        parentRequestId: "creq_ui",
        customerChargeCents: null,
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.customerChargeCents).toBe(3);
    expect(groups[0]?.operationCount).toBe(3);
  });

  it("does not treat historical tool rows as 3p", () => {
    const groups = groupOperationsIntoInteractions([
      usage({
        id: "old",
        action: "knowledge.search",
        customerChargeCents: 1,
        interactionId: "int_oldrow",
        companyId: EL_COMPANY_ID,
      }),
    ]);
    expect(groups[0]?.customerChargeCents).toBe(1);
  });

  it("seeds the EL request-level rule without touching global knowledge.search", async () => {
    const database = db();
    const seeded = await ensureElCustomerPricing(database);
    expect(seeded.policyId).toBe(EL_PRICING_POLICY_ID);
    expect(seeded.ruleId).toBe(EL_PRICING_RULE_ID);
    expect(database.tables.pricing_rules.filter((r) => r.action === "knowledge.search")).toHaveLength(1);
    expect(database.tables.pricing_rules.find((r) => r.id === EL_PRICING_RULE_ID)?.fixed_charge_cents).toBe(
      EL_CUSTOMER_REQUEST_PRICE_CENTS,
    );
    expect(isElChildUsageRow({
      companyId: EL_COMPANY_ID,
      action: "knowledge.search",
      parentRequestId: "creq_1",
      customerChargeCents: null,
    })).toBe(true);
    expect(channelFromSourceClient("portal_chat")).toBe("portal_chat");
    expect(usageRequestIdForElRequest("creq_1")).toBe("elreq_creq_1");
  });
});
