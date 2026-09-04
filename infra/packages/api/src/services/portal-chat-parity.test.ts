import { describe, expect, it } from "vitest";
import { elvexCan, elvexCapabilitiesForRole } from "@infra/shared";
import { evaluateActionPermission } from "../permissions/service";
import type { SessionUser } from "../auth/session";
import { buildConversationState, classifyScope, pickMailboxTool, runIntelligenceTurn } from "./intelligence/index";
import {
  describeUserAsk,
  isExplicitPermissionDenial,
  isHollowAssistantText,
  previousSubstantiveUserText,
} from "./intelligence/evidence.js";
import { answerGeneralConversation } from "./intelligence/conversation.js";
import { isPermissionDenial, polishPortalReply } from "./portal-chat";
import type { IntelligenceToolResult, IntelligenceTurnResult } from "./intelligence/types.js";

function user(role: SessionUser["memberships"][number]["role"]): SessionUser {
  return {
    userId: `user_${role}`,
    email: `${role}@elvexpropertyservices.com`,
    displayName: role,
    isPlatformAdmin: false,
    memberships: [{ companyId: "co_el", role, membershipId: `mem_${role}` }],
  };
}

const mockDb = {
  prepare: () => ({
    bind: () => ({
      all: async () => ({ results: [] }),
      first: async () => null,
    }),
  }),
} as unknown as D1Database;

const CHANNELS = ["portal", "chatgpt", "whatsapp"] as const;

const ACTIONS = [
  { action: "xero.sales.read" as const, mailbox: null, director: true, office: false },
  { action: "xero.sales.summary" as const, mailbox: null, director: true, office: false },
  { action: "knowledge.search" as const, mailbox: null, director: true, office: true },
  { action: "knowledge.read" as const, mailbox: null, director: true, office: true },
  {
    action: "outlook.search" as const,
    mailbox: "info@elvexpropertyservices.com",
    director: true,
    office: true,
  },
  {
    action: "outlook.search" as const,
    mailbox: "finance@elvexpropertyservices.com",
    director: true,
    office: false,
  },
];

describe("Portal Chat RBAC parity with shared gateway", () => {
  it("Director policy includes Xero and both mailboxes; office_staff does not", () => {
    expect(elvexCan("director", "xero.sales.read")).toBe(true);
    expect(elvexCan("director", "mail.info.read")).toBe(true);
    expect(elvexCan("director", "mail.finance.read")).toBe(true);
    expect(elvexCan("director", "knowledge.company.read")).toBe(true);
    expect(elvexCan("office_staff", "xero.sales.read")).toBe(false);
    expect(elvexCan("office_staff", "mail.finance.read")).toBe(false);
    expect(elvexCan("office_staff", "mail.info.read")).toBe(true);
    expect(elvexCapabilitiesForRole("director")).toContain("xero.sales.read");
  });

  it("permission decisions are identical for portal, ChatGPT, and WhatsApp actors", async () => {
    for (const role of ["director", "office_staff"] as const) {
      const actor = user(role);
      for (const row of ACTIONS) {
        const decisions = await Promise.all(
          CHANNELS.map(() =>
            evaluateActionPermission(mockDb, actor, "co_el", row.action, {
              mailboxAddress: row.mailbox,
            }),
          ),
        );
        expect(new Set(decisions.map((item) => item.allowed)).size).toBe(1);
        expect(decisions[0]?.allowed).toBe(role === "director" ? row.director : row.office);
      }
    }
  });

  it("does not treat successful Xero payloads as permission denials", () => {
    const data = {
      summary: { total: 12850.4, invoiceCount: 12, currency: "GBP" },
      permission_allowed: true,
      notes: "payment denied on customer side",
    };
    expect(isPermissionDenial(null, data)).toBe(false);
    expect(isExplicitPermissionDenial(null, data)).toBe(false);
    expect(isPermissionDenial("permission_denied", { status: 403, error: "permission_denied" })).toBe(true);
  });

  it("polish keeps live Xero figures instead of inventing a denial", () => {
    const result: IntelligenceTurnResult = {
      kind: "answer",
      text: "Xero sales are £12,850.40 across 12 invoices.",
      confidence: "partial",
      offerSearchOther: false,
      toolCalls: [
        {
          name: "xero_sales_summary",
          ok: true,
          latencyMs: 80,
          data: { summary: { total: 12850.4, invoiceCount: 12, currency: "GBP" }, permission_allowed: true },
        },
      ],
      currentDocument: null,
      evidenceDocumentIds: [],
      clarification: false,
      citeSource: false,
      modelRounds: [],
      totalModelMs: 0,
      totalToolMs: 80,
      provider: "workers-ai",
      model: "test",
      estimatedCostUsd: 0,
    };
    const text = polishPortalReply(result, "What are our Xero sales?");
    expect(text).toMatch(/12,850/);
    expect(text).not.toMatch(/permissions don’t allow/i);
  });
});

describe("Portal Chat conversation memory and more detail", () => {
  it("recalls the actual user question, not a default company-search topic", () => {
    const state = buildConversationState({
      userText: "what were we talking about?",
      lastAnswerTopic: "company_knowledge",
      lastAnswerText: "I need another moment to finish that. Try asking once more.",
      recentTurns: [
        { role: "user", text: "what is the PO process" },
        { role: "assistant", text: "I need another moment to finish that. Try asking once more." },
        { role: "user", text: "give me more detail" },
        { role: "assistant", text: "I need another moment to finish that. Try asking once more." },
      ],
    });
    const decision = classifyScope("what were we talking about?", state);
    expect(decision.lastUserIntent).toBe("memory");
    const reply = answerGeneralConversation("what were we talking about?", state, decision);
    expect(reply).toMatch(/PO process/i);
    expect(reply).not.toMatch(/searching company documents/i);
    expect(previousSubstantiveUserText(state.recentTurns, "what were we talking about?")).toBe(
      "what is the PO process",
    );
    expect(describeUserAsk("What are our Xero sales?")).toMatch(/Xero sales/i);
    expect(isHollowAssistantText("I need another moment to finish that. Try asking once more.")).toBe(true);
  });

  it("classifies give me more detail as a follow-up, not a new company search", () => {
    const decision = classifyScope(
      "give me more detail",
      buildConversationState({
        userText: "give me more detail",
        lastAnswerTopic: "company_knowledge",
        lastAnswerText: "I need another moment to finish that. Try asking once more.",
        recentTurns: [{ role: "user", text: "what is the PO process" }],
      }),
    );
    expect(decision.scope).toBe("GENERAL_CONVERSATION");
    expect(decision.lastUserIntent).toBe("more_detail");
    expect(decision.tool).toBeNull();
  });

  it("re-runs the previous substantive question for more detail after a hollow answer", async () => {
    const calls: string[] = [];
    const result = await runIntelligenceTurn({
      text: "give me more detail",
      state: buildConversationState({
        userText: "give me more detail",
        lastAnswerText: "I need another moment to finish that. Try asking once more.",
        recentTurns: [
          { role: "user", text: "What are our Xero sales?" },
          { role: "assistant", text: "I need another moment to finish that. Try asking once more." },
        ],
        connectors: ["conn_xero"],
        permittedTools: ["xero_sales_summary"],
      }),
      runtime: {
        async executeTool(call) {
          calls.push(call.name);
          return {
            name: call.name,
            ok: true,
            latencyMs: 4,
            data: { summary: { total: 99, invoiceCount: 2, currency: "GBP" } },
          };
        },
      },
      completer: async () => ({
        text: JSON.stringify({ action: "answer", text: "Xero sales are £99.00 across 2 invoices.", confidence: "strong" }),
        usage: { provider: "none", model: null, latencyMs: 1, promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 },
      }),
    });
    expect(calls).toContain("xero_sales_summary");
    expect(result.text).not.toMatch(/I need another moment/i);
    expect(result.scope).toBe("BUSINESS_SYSTEM");
  });
});

describe("Portal Chat scoped tool execution", () => {
  it("executes Xero and mailbox tools instead of returning the generic retry", async () => {
    const cases: Array<{ text: string; tool: string; data: unknown }> = [
      {
        text: "What are our Xero sales?",
        tool: "xero_sales_summary",
        data: { summary: { total: 2500, invoiceCount: 3, currency: "GBP" } },
      },
      {
        text: "What is the newest email in the info inbox?",
        tool: "outlook_list_messages",
        data: {
          mailboxAddress: "info@elvexpropertyservices.com",
          messages: [
            {
              subject: "Site visit Tuesday",
              from: "client@example.com",
              receivedDateTime: "2026-09-03T09:00:00Z",
            },
          ],
        },
      },
      {
        text: "What is the newest email in the finance inbox?",
        tool: "outlook_list_messages",
        data: {
          mailboxAddress: "finance@elvexpropertyservices.com",
          messages: [
            {
              subject: "Supplier remittance",
              from: "accounts@example.com",
              receivedDateTime: "2026-09-02T16:00:00Z",
            },
          ],
        },
      },
    ];
    for (const row of cases) {
      expect(pickMailboxTool(row.text).startsWith("outlook_") || row.tool.startsWith("xero_")).toBe(true);
      const result = await runIntelligenceTurn({
        text: row.text,
        state: buildConversationState({
          userText: row.text,
          connectors: ["conn_xero", "conn_outlook_shared"],
        }),
        runtime: {
          async executeTool(call): Promise<IntelligenceToolResult> {
            return { name: call.name, ok: true, latencyMs: 3, data: row.data };
          },
        },
        completer: async () => ({
          text: "",
          usage: { provider: "workers-ai", model: "test", latencyMs: 1, promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 },
        }),
      });
      expect(result.toolCalls.some((call) => call.name === row.tool)).toBe(true);
      expect(result.text).not.toMatch(/I need another moment/i);
      expect(result.text.length).toBeGreaterThan(10);
    }
  });

  it("returns a structured mailbox failure instead of asking the user to retry", async () => {
    const result = await runIntelligenceTurn({
      text: "What is the newest email in the info inbox?",
      state: buildConversationState({
        userText: "What is the newest email in the info inbox?",
        connectors: ["conn_outlook_shared"],
      }),
      runtime: {
        async executeTool(call) {
          return { name: call.name, ok: false, latencyMs: 8, data: null, error: "timeout" };
        },
      },
      completer: async () => ({
        text: "",
        usage: { provider: "workers-ai", model: "test", latencyMs: 1, promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 },
      }),
    });
    expect(result.kind).toBe("failed");
    expect(result.text).toMatch(/Outlook is unreachable/i);
    expect(result.text).not.toMatch(/Try asking once more/i);
  });

  it("office_staff Xero denial stays a permission denial with no figures", async () => {
    const result = await runIntelligenceTurn({
      text: "What are our Xero sales?",
      state: buildConversationState({
        userText: "What are our Xero sales?",
        role: "office_staff",
        connectors: ["conn_xero"],
      }),
      runtime: {
        async executeTool(call) {
          return {
            name: call.name,
            ok: false,
            latencyMs: 5,
            data: { status: 403, error: "Elvex role does not grant xero.sales.read" },
            error: "Elvex role does not grant xero.sales.read",
          };
        },
      },
    });
    expect(result.kind).toBe("failed");
    expect(result.text).toMatch(/permission|not grant|not allow/i);
    expect(result.text).not.toMatch(/£\s?\d/);
    expect(result.text).not.toMatch(/I need another moment/i);
  });
});
