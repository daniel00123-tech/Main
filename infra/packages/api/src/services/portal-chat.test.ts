import { describe, expect, it, beforeEach } from "vitest";
import type { SessionUser } from "../auth/session";
import { evaluateActionPermission } from "../permissions/service";
import { buildConversationState, runIntelligenceTurn } from "./intelligence/index";
import type { IntelligenceCompleter } from "./intelligence/provider.js";
import type { IntelligenceChannel } from "./intelligence/types.js";
import {
  createPortalConversation,
  getPortalConversation,
  isPermissionDenial,
  listPortalConversations,
  polishPortalReply,
  resetPortalChatSchemaCache,
  resolvePortalChatAccess,
  sendPortalChatMessage,
  titleFromUserText,
} from "./portal-chat";
import { PORTAL_CHAT_SOURCE_CLIENT, toolStatusLabel } from "./portal-chat-types";
import { normalizeSourceClient } from "./usage-attribution";
import type { Env } from "../env";

type Row = Record<string, unknown>;

function memoryDb() {
  const conversations: Row[] = [];
  const messages: Row[] = [];
  const memberships: Row[] = [];
  const companies: Row[] = [{ id: "co_el", name: "Elvex", slug: "elvex" }];

  function run(sql: string, values: unknown[]) {
    if (sql.startsWith("CREATE")) return { success: true };
    if (sql.includes("INSERT INTO portal_conversations")) {
      conversations.push({
        id: values[0],
        company_id: values[1],
        user_id: values[2],
        title: values[3],
        context_json: "{}",
        created_at: values[4],
        updated_at: values[5],
      });
      return { success: true };
    }
    if (sql.includes("INSERT INTO portal_conversation_messages")) {
      messages.push({
        id: values[0],
        conversation_id: values[1],
        company_id: values[2],
        user_id: values[3],
        role: values[4],
        content: values[5],
        metadata_json: values[6],
        created_at: values[7],
      });
      return { success: true };
    }
    if (sql.includes("UPDATE portal_conversations SET context_json")) {
      const row = conversations.find((item) => item.id === values[3] && item.company_id === values[4] && item.user_id === values[5]);
      if (row) {
        row.context_json = values[0];
        row.title = values[1];
        row.updated_at = values[2];
      }
      return { success: true };
    }
    if (sql.includes("UPDATE portal_conversations SET title")) {
      const row = conversations.find((item) => item.id === values[2] && item.company_id === values[3] && item.user_id === values[4]);
      if (row) {
        row.title = values[0];
        row.updated_at = values[1];
      }
      return { success: true };
    }
    if (sql.includes("FROM portal_conversations") && sql.includes("ORDER BY updated_at")) {
      return conversations
        .filter((row) => row.company_id === values[0] && row.user_id === values[1])
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    }
    if (sql.includes("FROM portal_conversations") && sql.includes("WHERE id = ?")) {
      return conversations.find((row) => row.id === values[0] && row.company_id === values[1] && row.user_id === values[2]) ?? null;
    }
    if (sql.includes("FROM portal_conversation_messages")) {
      return messages
        .filter((row) => row.conversation_id === values[0] && row.company_id === values[1])
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    }
    if (sql.includes("FROM company_memberships")) {
      return (
        memberships.find((row) => row.user_id === values[0] && row.company_id === values[1]) ?? null
      );
    }
    if (sql.includes("FROM companies WHERE id")) {
      return companies.find((row) => row.id === values[0]) ?? null;
    }
    if (sql.includes("FROM connector_instances")) return [];
    return null;
  }

  const db = {
    conversations,
    messages,
    memberships,
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first() {
              const result = run(sql, values);
              return Array.isArray(result) ? result[0] ?? null : result;
            },
            async all() {
              const result = run(sql, values);
              return { results: Array.isArray(result) ? result : result ? [result] : [] };
            },
            async run() {
              run(sql, values);
              return { success: true };
            },
          };
        },
        async run() {
          run(sql, []);
          return { success: true };
        },
      };
    },
  };
  return db as unknown as D1Database & { conversations: Row[]; messages: Row[]; memberships: Row[] };
}

function user(role: SessionUser["memberships"][number]["role"], companyId = "co_el"): SessionUser {
  return {
    userId: role === "office_staff" ? "user_william" : `user_${role}`,
    email: role === "office_staff" ? "william@elvexpropertyservices.com" : `${role}@elvexpropertyservices.com`,
    displayName: role,
    isPlatformAdmin: false,
    memberships: [{ companyId, role }],
  };
}

const mockPermDb = {
  prepare: () => ({
    bind: () => ({
      all: async () => ({ results: [] }),
      first: async () => null,
    }),
  }),
} as unknown as D1Database;

function greetingCompleter(): IntelligenceCompleter {
  return async () => ({
    text: JSON.stringify({ action: "answer", text: "Hi — I'm here if you need anything.", confidence: "strong", offer_search_other: false, cite_source: false }),
    usage: { provider: "none", model: null, latencyMs: 1, promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 },
  });
}

function xeroCompleter(): IntelligenceCompleter {
  return async () => ({
    text: JSON.stringify({ action: "call_tool", name: "xero_sales_summary", arguments: { fromDate: "2026-08-01", toDate: "2026-08-31" } }),
    usage: { provider: "none", model: null, latencyMs: 1, promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 },
  });
}

beforeEach(() => {
  resetPortalChatSchemaCache();
});

describe("portal chat channel", () => {
  it("keeps conversation history per user and company", async () => {
    const db = memoryDb();
    const william = user("office_staff");
    const created = await createPortalConversation(db, { companyId: "co_el", userId: william.userId, title: "CV search" });
    await sendPortalChatMessage({ DB: db } as Env, {
      companyId: "co_el",
      sessionUser: william,
      conversationId: created.id,
      text: "hi",
      completer: greetingCompleter(),
      connectors: [],
      executeGateway: async () => ({ status: 200, result: {} }) as never,
    });
    const mine = await listPortalConversations(db, "co_el", william.userId);
    const other = await listPortalConversations(db, "co_ht", william.userId);
    const stranger = await getPortalConversation(db, {
      conversationId: created.id,
      companyId: "co_el",
      userId: "user_other",
    });
    expect(mine).toHaveLength(1);
    expect(other).toHaveLength(0);
    expect(stranger).toBeNull();
  });

  it("uses compact recent turns instead of unlimited history", async () => {
    const recentTurns = Array.from({ length: 24 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `turn ${index} ${"x".repeat(80)}`,
    }));
    const state = buildConversationState({
      userText: "what did we say about vehicles?",
      recentTurns,
      companyId: "co_el",
    });
    expect(state.recentTurns.length).toBeLessThanOrEqual(10);
    expect(state.recentTurns.every((turn) => turn.text.length <= 360)).toBe(true);
  });

  it("empty and invalid messages stay user-facing", async () => {
    expect(titleFromUserText("")).toBe("New chat");
    await expect(
      sendPortalChatMessage({ DB: memoryDb() } as Env, {
        companyId: "co_el",
        sessionUser: user("office_staff"),
        text: "   ",
        completer: greetingCompleter(),
        connectors: [],
      }),
    ).rejects.toThrow("Message cannot be empty");
  });

  it("attributes portal chat as portal_chat without inventing prices", () => {
    expect(normalizeSourceClient("portal_chat")).toBe(PORTAL_CHAT_SOURCE_CLIENT);
    expect(normalizeSourceClient("portal")).toBe("portal");
    expect(toolStatusLabel("xero_sales_summary")).toBe("Checking Xero…");
    expect(toolStatusLabel("search_company_knowledge")).toBe("Searching company files…");
  });
});

describe("shared intelligence across ChatGPT, WhatsApp, and portal chat", () => {
  const channels: IntelligenceChannel[] = ["whatsapp", "portal", "api"];

  it("greetings take the same local path on every channel", async () => {
    for (const channel of channels) {
      const result = await runIntelligenceTurn({
        text: "hi",
        state: buildConversationState({ userText: "hi", connectors: [], permittedTools: [] }),
        runtime: { async executeTool() { throw new Error("no tools on greeting"); } },
        channel,
      });
      expect(result.kind === "fast_path" || result.kind === "answer").toBe(true);
      expect(result.toolCalls).toHaveLength(0);
    }
  });

  it("blocks writes as controlled actions on every channel", async () => {
    for (const channel of channels) {
      const result = await runIntelligenceTurn({
        text: "create an invoice for Acme for £120",
        state: buildConversationState({ userText: "create an invoice for Acme for £120", connectors: ["conn_xero"] }),
        runtime: {
          async executeTool() {
            throw new Error("writes must not execute");
          },
        },
        channel,
      });
      expect(result.kind).toBe("controlled_action");
      expect(result.toolCalls).toHaveLength(0);
    }
  });

  it("William office_staff has the same permission decision on every channel", async () => {
    const william = user("office_staff");
    const finance = user("finance_team");
    const cases = [
      { action: "knowledge.search" as const, office: true, financeTeam: true },
      { action: "knowledge.read" as const, office: true, financeTeam: true },
      { action: "xero.invoices.read" as const, office: false, financeTeam: true },
      { action: "xero.reports.profit_and_loss" as const, office: false, financeTeam: true },
    ];
    for (const row of cases) {
      const officeDecision = await evaluateActionPermission(mockPermDb, william, "co_el", row.action);
      const financeDecision = await evaluateActionPermission(mockPermDb, finance, "co_el", row.action);
      expect(officeDecision.allowed).toBe(row.office);
      expect(financeDecision.allowed).toBe(row.financeTeam);
    }
    expect(
      (
        await evaluateActionPermission(mockPermDb, william, "co_el", "knowledge.search", {
          mailboxAddress: "info@elvexpropertyservices.com",
        })
      ).allowed,
    ).toBe(true);
    expect(
      (
        await evaluateActionPermission(mockPermDb, william, "co_el", "outlook.search" as never, {
          mailboxAddress: "finance@elvexpropertyservices.com",
        })
      ).allowed,
    ).toBe(false);
  });

  it("portal chat surfaces a permission denial instead of invented Xero figures", async () => {
    const db = memoryDb();
    db.memberships.push({
      user_id: "user_william",
      company_id: "co_el",
      membership_id: "mem_w",
      role: "office_staff",
      user_status: "active",
      membership_status: "active",
      email: "william@elvexpropertyservices.com",
      display_name: "William",
      is_platform_admin: 0,
    });
    const result = await sendPortalChatMessage({ DB: db } as Env, {
      companyId: "co_el",
      sessionUser: user("office_staff"),
      text: "what were last month's sales in Xero?",
      completer: xeroCompleter(),
      connectors: ["conn_xero"],
      executeGateway: async (_env, input) => {
        expect(input.sourceClient).toBe(PORTAL_CHAT_SOURCE_CLIENT);
        return { status: 403, error: "Xero is not available for your role" } as never;
      },
    });
    expect(result.assistantMessage.metadata.permissionDenied).toBe(true);
    expect(result.assistantMessage.content).toMatch(/permission|not available|cannot|can't|do not have/i);
    expect(result.assistantMessage.content).not.toMatch(/£\s?\d/);
  });

  it("live membership denial takes effect immediately", async () => {
    const db = memoryDb();
    db.memberships.push({
      user_id: "user_william",
      company_id: "co_el",
      membership_id: "mem_w",
      role: "office_staff",
      user_status: "active",
      membership_status: "disabled",
      email: "william@elvexpropertyservices.com",
      display_name: "William",
      is_platform_admin: 0,
      deny_reason: "Company membership is disabled",
    });
    const access = await resolvePortalChatAccess(db, user("office_staff"), "co_el");
    expect(access.ok).toBe(false);
  });
});

describe("portal chat polish", () => {
  it("does not leak raw tool JSON", () => {
    const text = polishPortalReply(
      {
        kind: "failed",
        text: "",
        confidence: "none",
        offerSearchOther: false,
        toolCalls: [{ name: "xero_sales_summary", ok: false, latencyMs: 4, data: { status: 403, error: "permission denied" }, error: "permission denied" }],
        currentDocument: null,
        evidenceDocumentIds: [],
        clarification: false,
        citeSource: false,
        modelRounds: [],
        totalModelMs: 0,
        totalToolMs: 4,
        provider: "none",
        model: null,
        estimatedCostUsd: 0,
      },
      "sales last month",
    );
    expect(text).not.toContain("{");
    expect(text).toMatch(/permission denied/i);
    expect(isPermissionDenial("permission denied", { status: 403 })).toBe(true);
  });

  it("does not treat a successful Xero payload as a permission denial", () => {
    expect(
      isPermissionDenial(null, {
        source: "Xero",
        sales_total: 4554,
        invoices: [{ invoiceNumber: "INV-02268", status: "AUTHORISED", reference: "payment not denied" }],
      }),
    ).toBe(false);
    expect(
      polishPortalReply(
        {
          kind: "answered",
          text: "Sales this month are £4,554.",
          confidence: "high",
          offerSearchOther: false,
          toolCalls: [
            {
              name: "xero_sales_summary",
              ok: true,
              latencyMs: 40,
              data: { source: "Xero", sales_total: 4554, notes: "none denied" },
            },
          ],
          currentDocument: null,
          evidenceDocumentIds: [],
          clarification: false,
          citeSource: false,
          modelRounds: [],
          totalModelMs: 0,
          totalToolMs: 40,
          provider: "none",
          model: null,
          estimatedCostUsd: 0,
        },
        "What are our Xero sales this month?",
      ),
    ).toBe("Sales this month are £4,554.");
  });
});
