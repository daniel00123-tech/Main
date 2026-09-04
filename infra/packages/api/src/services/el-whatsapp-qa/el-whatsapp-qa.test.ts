import { describe, expect, it } from "vitest";
import { classifyScope } from "../intelligence/scope.js";
import { buildConversationState } from "../intelligence/state.js";
import { runIntelligenceTurn } from "../intelligence/orchestrator.js";
import { isGenericRetryCopy } from "../intelligence/verbalise-business.js";
import type { IntelligenceCompleter } from "../intelligence/provider.js";
import type { IntelligenceRuntime, IntelligenceToolResult } from "../intelligence/types.js";
import { EL_BUSINESS_WHATSAPP_50_V1, SUITE_ID } from "./el-business-whatsapp-50-v1.js";
import { classifyFrozenSuite } from "./campaign.js";
import { scoreTurn, tallyGrades } from "./score.js";

const silentCompleter: IntelligenceCompleter = async () => ({
  text: JSON.stringify({
    action: "answer",
    text: "I need another moment to finish that. Try asking once more.",
    confidence: "none",
    offer_search_other: false,
    cite_source: false,
  }),
  usage: {
    provider: "workers-ai",
    model: "@cf/meta/llama-4-scout-17b-16e-instruct",
    latencyMs: 10,
    promptTokens: 8,
    completionTokens: 8,
    estimatedCostUsd: 0,
  },
});

function runtime(
  handler: (name: string, args: Record<string, unknown>) => IntelligenceToolResult | Record<string, unknown>,
): { runtime: IntelligenceRuntime; calls: Array<{ name: string; arguments: Record<string, unknown> }> } {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  return {
    calls,
    runtime: {
      async executeTool(call): Promise<IntelligenceToolResult> {
        calls.push({ name: call.name, arguments: call.arguments });
        const raw = handler(call.name, call.arguments);
        if (raw && typeof raw === "object" && "ok" in raw && "name" in raw) {
          return raw as IntelligenceToolResult;
        }
        return { name: call.name, ok: true, latencyMs: 6, data: raw };
      },
    },
  };
}

function xeroState(text: string) {
  return buildConversationState({
    userText: text,
    lastAnswerTopic: "finance",
    currentScope: "BUSINESS_SYSTEM",
    currentBusinessSystem: "xero",
    lastSuccessfulTool: "xero_sales_summary",
    lastAnswerText: "Xero sales from 2026-09-01 to 2026-09-04 are £5,094 across 32 invoices.",
    connectors: ["conn_xero", "conn_outlook_shared"],
  });
}

function emailState(text: string) {
  return buildConversationState({
    userText: text,
    lastAnswerTopic: "email",
    currentScope: "BUSINESS_SYSTEM",
    currentBusinessSystem: "email",
    lastSuccessfulTool: "outlook_list_messages",
    lastAnswerText: "The newest email in info@elvexpropertyservices.com is “Leak detection” from ops@example.com (2026-09-04).",
    connectors: ["conn_xero", "conn_outlook_shared"],
  });
}

describe("el-business-whatsapp-50-v1 frozen suite", () => {
  it("freezes exactly 50 unique prompts with the required wording", () => {
    expect(SUITE_ID).toBe("el-business-whatsapp-50-v1");
    expect(EL_BUSINESS_WHATSAPP_50_V1).toHaveLength(50);
    expect(new Set(EL_BUSINESS_WHATSAPP_50_V1.map((row) => row.id)).size).toBe(50);
    expect(EL_BUSINESS_WHATSAPP_50_V1.map((row) => row.section).filter((s) => s === "A")).toHaveLength(15);
    expect(EL_BUSINESS_WHATSAPP_50_V1.map((row) => row.section).filter((s) => s === "B")).toHaveLength(15);
    expect(EL_BUSINESS_WHATSAPP_50_V1.map((row) => row.section).filter((s) => s === "C")).toHaveLength(8);
    expect(EL_BUSINESS_WHATSAPP_50_V1.map((row) => row.section).filter((s) => s === "D")).toHaveLength(7);
    expect(EL_BUSINESS_WHATSAPP_50_V1.map((row) => row.section).filter((s) => s === "E")).toHaveLength(5);
    expect(EL_BUSINESS_WHATSAPP_50_V1.find((row) => row.id === "A1")?.text).toBe("What are our Xero sales today?");
    expect(EL_BUSINESS_WHATSAPP_50_V1.find((row) => row.id === "A15")?.text).toBe("whats our xero sales this mnth");
    expect(EL_BUSINESS_WHATSAPP_50_V1.find((row) => row.id === "B12")?.text).toBe("find emials from Sharon");
    expect(EL_BUSINESS_WHATSAPP_50_V1.find((row) => row.id === "C7")?.text).toBe("No, I meant email.");
    expect(EL_BUSINESS_WHATSAPP_50_V1.find((row) => row.id === "E2")?.text).toBe(
      "What is the newest email in the finance inbox?",
    );
  });

  it("routes every frozen prompt to the expected EL family", () => {
    const classified = classifyFrozenSuite();
    const byId = new Map(classified.map((row) => [row.id, row]));
    const misses: string[] = [];
    for (const question of EL_BUSINESS_WHATSAPP_50_V1) {
      const got = byId.get(question.id);
      const tool = got?.tool ?? null;
      const expected = question.expectedToolPrefix;
      const ok =
        expected == null
          ? !tool
          : Boolean(tool && (tool === expected || tool.startsWith(expected.replace(/_$/, "")) || tool.startsWith(expected)));
      if (!ok) misses.push(`${question.id} "${question.text}" expected=${expected} got=${got?.scope}/${tool}`);
    }
    expect(misses).toEqual([]);
  });

  it("does not send Xero questions to knowledge or email to Xero", () => {
    for (const question of EL_BUSINESS_WHATSAPP_50_V1.filter((row) => row.family === "xero")) {
      const state =
        question.section === "D"
          ? xeroState(question.text)
          : buildConversationState({ userText: question.text });
      const decision = classifyScope(question.text, state);
      expect(decision.tool, question.id).toMatch(/^xero_/);
      expect(decision.tool, question.id).not.toBe("search_company_knowledge");
      expect(decision.tool, question.id).not.toBe("database_summary");
    }
    for (const question of EL_BUSINESS_WHATSAPP_50_V1.filter((row) => row.family === "outlook")) {
      const state =
        question.id === "D7" ? xeroState(question.text) : buildConversationState({ userText: question.text });
      const decision = classifyScope(question.text, state);
      expect(decision.tool, question.id).toMatch(/^outlook_/);
      expect(decision.tool, question.id).not.toMatch(/^xero_/);
    }
  });
});

describe("EL WhatsApp deterministic campaign behaviours", () => {
  it("passes INV-02268 as invoiceNumber and summarises the invoice", async () => {
    const { runtime: exec, calls } = runtime(() => ({
      invoice: { invoiceNumber: "INV-02268", contact: "North Yard", total: 480, status: "AUTHORISED" },
    }));
    const result = await runIntelligenceTurn({
      text: "Show me invoice INV-02268.",
      state: buildConversationState({ userText: "Show me invoice INV-02268.", connectors: ["conn_xero"] }),
      runtime: exec,
      completer: silentCompleter,
      channel: "whatsapp",
    });
    expect(calls[0]?.name).toBe("xero_get_invoice");
    expect(String(calls[0]?.arguments.invoiceNumber ?? "")).toBe("INV-02268");
    expect(isGenericRetryCopy(result.text)).toBe(false);
    expect(result.text).toMatch(/INV-02268/);
  });

  it("lists top customers without inventing a figure", async () => {
    const { runtime: exec, calls } = runtime(() => ({
      customers: [{ name: "North Yard", total: 1200 }],
    }));
    const result = await runIntelligenceTurn({
      text: "Who are our top customers this month?",
      state: buildConversationState({ userText: "Who are our top customers this month?", connectors: ["conn_xero"] }),
      runtime: exec,
      completer: silentCompleter,
      channel: "whatsapp",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("xero_top_customers");
    expect(result.text).toMatch(/North Yard/);
    expect(isGenericRetryCopy(result.text)).toBe(false);
  });

  it("counts only returned Sharon emails", async () => {
    const { runtime: exec, calls } = runtime(() => ({
      mailboxAddress: "info@elvexpropertyservices.com",
      messages: [
        { subject: "PO 12", from: "Sharon", receivedDateTime: "2026-09-04T09:00:00Z" },
        { subject: "Site", from: "Sharon", receivedDateTime: "2026-09-04T10:00:00Z" },
      ],
    }));
    const result = await runIntelligenceTurn({
      text: "How many emails has Sharon sent today?",
      state: buildConversationState({
        userText: "How many emails has Sharon sent today?",
        connectors: ["conn_outlook_shared"],
      }),
      runtime: exec,
      completer: silentCompleter,
      channel: "whatsapp",
    });
    expect(calls[0]?.name).toBe("outlook_search_mailbox");
    expect(String(calls[0]?.arguments.query ?? "")).toMatch(/Sharon/i);
    expect(result.text).toMatch(/2 matching email/);
  });

  it("loads the full latest info email after listing", async () => {
    const { runtime: exec, calls } = runtime((name) => {
      if (name === "outlook_get_message") {
        return {
          id: "AAMk-1",
          mailboxAddress: "info@elvexpropertyservices.com",
          subject: "Leak detection",
          from: "ops@example.com",
          body: "Please attend server room 3.",
        };
      }
      return {
        mailboxAddress: "info@elvexpropertyservices.com",
        messages: [{ id: "AAMk-1", subject: "Leak detection", from: "ops@example.com" }],
      };
    });
    const result = await runIntelligenceTurn({
      text: "Show me the full latest info email.",
      state: buildConversationState({
        userText: "Show me the full latest info email.",
        connectors: ["conn_outlook_shared"],
      }),
      runtime: exec,
      completer: silentCompleter,
      channel: "whatsapp",
    });
    expect(calls.map((call) => call.name)).toEqual(["outlook_list_messages", "outlook_get_message"]);
    expect(result.text).toMatch(/server room 3/);
  });

  it("runs Xero then finance Outlook for the compound sales+email ask", async () => {
    const { runtime: exec, calls } = runtime((name) => {
      if (name.startsWith("xero_")) {
        return { source: "Xero", sales_total: 5094, invoice_count: 32, period: { fromDate: "2026-09-01", toDate: "2026-09-04" } };
      }
      return {
        mailboxAddress: "finance@elvexpropertyservices.com",
        messages: [{ subject: "Nailah Toyer Documents", from: "ap@example.com" }],
      };
    });
    const result = await runIntelligenceTurn({
      text: "What are our sales and then show the latest finance email?",
      state: buildConversationState({
        userText: "What are our sales and then show the latest finance email?",
        connectors: ["conn_xero", "conn_outlook_shared"],
      }),
      runtime: exec,
      completer: silentCompleter,
      channel: "whatsapp",
    });
    expect(calls.map((call) => call.name)).toEqual(["xero_sales_summary", "outlook_list_messages"]);
    expect(result.text).toMatch(/5,094|5094/);
    expect(result.text).toMatch(/Nailah Toyer/);
  });

  it("routes Xero invoices with PO references to invoice search", () => {
    const decision = classifyScope(
      "Show Xero invoices with PO references.",
      buildConversationState({ userText: "Show Xero invoices with PO references." }),
    );
    expect(decision.tool).toBe("xero_search_invoices");
  });

  it("replans corrections from Xero to email and email to Xero", async () => {
    const toEmail = classifyScope("No, I meant email.", xeroState("No, I meant email."));
    expect(toEmail.tool).toBe("outlook_list_messages");
    expect(toEmail.tool).not.toMatch(/^xero_/);
    const toXero = classifyScope("No, I meant Xero.", emailState("No, I meant Xero."));
    expect(toXero.tool).toMatch(/^xero_/);
    expect(toXero.tool).not.toMatch(/^outlook_/);
  });

  it("keeps follow-ups on Xero context and switches for emails behind that", async () => {
    expect(classifyScope("More detail.", xeroState("More detail.")).scope).toBe("GENERAL_CONVERSATION");
    expect(classifyScope("What were we talking about?", xeroState("What were we talking about?")).scope).toBe(
      "GENERAL_CONVERSATION",
    );
    expect(classifyScope("What about last month?", xeroState("What about last month?")).tool).toMatch(/^xero_/);
    expect(classifyScope("Show me the emails behind that.", xeroState("Show me the emails behind that.")).tool).toMatch(
      /^outlook_/,
    );
  });

  it("surfaces a 502 as an upstream failure, not no-results", async () => {
    const down = await runIntelligenceTurn({
      text: "What is the newest email in the info inbox?",
      state: buildConversationState({ userText: "What is the newest email in the info inbox?" }),
      runtime: {
        async executeTool(call) {
          return { name: call.name, ok: false, latencyMs: 5, data: { status: 502 }, error: "upstream" };
        },
      },
      completer: silentCompleter,
      channel: "whatsapp",
    });
    expect(down.text).toMatch(/couldn.?t reach Email/i);
    expect(down.text).not.toMatch(/couldn.?t find any matching emails/i);
    expect(isGenericRetryCopy(down.text)).toBe(false);
  });

  it("scores office_staff Xero denial as GOOD and a leak as UNUSABLE", () => {
    const question = EL_BUSINESS_WHATSAPP_50_V1.find((row) => row.id === "E1")!;
    const denied = scoreTurn({
      question,
      role: "office_staff",
      reply: "Your current permissions don’t allow this action.",
      tools: ["xero_sales_summary"],
      scope: "BUSINESS_SYSTEM",
      latencyMs: 20,
      settlement: "denied",
      charged: false,
      toolOk: [false],
    });
    expect(denied.grade).toBe("GOOD");
    const leak = scoreTurn({
      question,
      role: "office_staff",
      reply: "Xero sales are £9,999 across 12 invoices.",
      tools: ["xero_sales_summary"],
      scope: "BUSINESS_SYSTEM",
      latencyMs: 20,
      charged: true,
      toolOk: [true],
    });
    expect(leak.grade).toBe("UNUSABLE");
    expect(leak.permissionLeak).toBe(true);
    expect(tallyGrades([denied, leak]).UNUSABLE).toBe(1);
  });
});
