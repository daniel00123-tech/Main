import { describe, expect, it } from "vitest";
import { runIntelligenceTurn } from "./orchestrator.js";
import { buildConversationState } from "./state.js";
import { isGenericRetryCopy } from "./verbalise-business.js";
import type { IntelligenceCompleter } from "./provider.js";
import type { IntelligenceRuntime, IntelligenceToolResult } from "./types.js";

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
    latencyMs: 40,
    promptTokens: 20,
    completionTokens: 12,
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
        return { name: call.name, ok: true, latencyMs: 8, data: raw };
      },
    },
  };
}

describe("deterministic business and knowledge reads", () => {
  it("calls Outlook list_messages for newest info email without waiting on the LLM", async () => {
    const { runtime: exec, calls } = runtime(() => ({
      mailboxAddress: "info@elvexpropertyservices.com",
      messages: [
        {
          subject: "Site visit tomorrow",
          from: "client@example.com",
          receivedDateTime: "2026-09-04T09:12:00Z",
        },
      ],
    }));
    const result = await runIntelligenceTurn({
      text: "What is the newest email in the info inbox?",
      state: buildConversationState({
        userText: "What is the newest email in the info inbox?",
        connectors: ["conn_outlook_shared"],
        permittedTools: ["outlook_list_messages", "outlook_search_mailbox", "search_company_knowledge"],
      }),
      runtime: exec,
      completer: silentCompleter,
      channel: "portal",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("outlook_list_messages");
    expect(String(calls[0]?.arguments.mailboxAddress ?? "")).toMatch(/info@/i);
    expect(isGenericRetryCopy(result.text)).toBe(false);
    expect(result.text).toMatch(/Site visit tomorrow/);
    expect(result.toolCalls[0]?.ok).toBe(true);
  });

  it("keeps the deterministic Outlook read under the OpenAI PA brain and still synthesises from evidence", async () => {
    const { runtime: exec, calls } = runtime(() => ({
      mailboxAddress: "info@elvexpropertyservices.com",
      messages: [
        {
          subject: "Site visit tomorrow",
          from: "client@example.com",
          receivedDateTime: "2026-09-04T09:12:00Z",
        },
      ],
    }));
    const result = await runIntelligenceTurn({
      env: {
        OPENAI_API_KEY: "sk-test-key-1234567890abcdef",
        OPENAI_BRAIN_ENABLED: "true",
        OPENAI_BRAIN_MODE: "openai_shadow",
        OPENAI_BRAIN_COMPANY_IDS: "co_el",
      },
      text: "What is the newest email in the info inbox?",
      state: buildConversationState({
        userText: "What is the newest email in the info inbox?",
        companyId: "co_el",
        connectors: ["conn_outlook_shared"],
        permittedTools: ["outlook_list_messages", "outlook_search_mailbox", "search_company_knowledge"],
      }),
      runtime: exec,
      completer: silentCompleter,
      channel: "portal_chat",
    });
    expect(calls[0]?.name).toBe("outlook_list_messages");
    expect(calls.filter((call) => call.name.startsWith("outlook_"))).toHaveLength(1);
    expect(isGenericRetryCopy(result.text)).toBe(false);
    expect(result.text).toMatch(/Site visit tomorrow/);
    expect(result.userVisibleBrain).toBe("openai");
    expect(result.brainRole).toBe("pa");
  });

  it("does not let the OpenAI PA brain re-search the same mailbox", async () => {
    let searches = 0;
    const { runtime: exec, calls } = runtime((name) => {
      if (name === "outlook_search_mailbox") {
        searches += 1;
        return {
          mailboxAddress: "info@elvexpropertyservices.com",
          messages: [{ subject: "Quote request", from: "ops@example.com", receivedDateTime: "2026-09-04T15:41:00Z" }],
        };
      }
      return { messages: [] };
    });
    const result = await runIntelligenceTurn({
      env: {
        OPENAI_API_KEY: "sk-test-key-1234567890abcdef",
        OPENAI_BRAIN_ENABLED: "true",
        OPENAI_BRAIN_MODE: "openai_shadow",
        OPENAI_BRAIN_COMPANY_IDS: "co_el",
      },
      text: "Search the info inbox for anything about a quote request.",
      state: buildConversationState({
        userText: "Search the info inbox for anything about a quote request.",
        companyId: "co_el",
        connectors: ["conn_outlook_shared"],
        permittedTools: ["outlook_list_messages", "outlook_search_mailbox", "search_company_knowledge"],
      }),
      runtime: exec,
      completer: async () => ({
        text: JSON.stringify({ action: "call_tool", name: "outlook_search_mailbox", arguments: { query: "quote" } }),
        usage: {
          provider: "openai",
          model: "gpt-test",
          latencyMs: 20,
          promptTokens: 10,
          completionTokens: 8,
          estimatedCostUsd: 0,
        },
      }),
      channel: "portal_chat",
    });
    expect(searches).toBe(1);
    expect(calls.filter((call) => call.name === "outlook_search_mailbox")).toHaveLength(1);
    expect(result.toolCalls.filter((call) => call.name === "outlook_search_mailbox")).toHaveLength(1);
  });

  it("plans knowledge plus warehouse for a named document mixed with April sales", async () => {
    const { runtime: exec, calls } = runtime((name) => {
      if (name === "search_company_knowledge") {
        return { results: [{ id: "doc_admin", title: "Admin Structure September 2026", snippet: "Office roles." }] };
      }
      if (name.startsWith("warehouse_")) {
        return { sales: 12000, fromDate: "2026-04-01", toDate: "2026-04-30", warehouse_as_of: "2026-09-05", completeness_status: "COMPLETE" };
      }
      return { messages: [] };
    });
    const result = await runIntelligenceTurn({
      text: "April warehouse sales together with the admin structure document.",
      state: buildConversationState({
        userText: "April warehouse sales together with the admin structure document.",
        connectors: ["conn_xero", "conn_outlook_shared"],
        permittedTools: ["warehouse_sales_analysis", "search_company_knowledge", "list_documents"],
      }),
      runtime: exec,
      completer: silentCompleter,
      channel: "portal",
    });
    expect(calls.some((call) => call.name === "search_company_knowledge")).toBe(true);
    expect(calls.some((call) => call.name === "warehouse_sales_analysis")).toBe(true);
    expect(calls.some((call) => call.name === "list_documents")).toBe(false);
    expect(result.text).toMatch(/Admin Structure|£12,000|12000/i);
    expect(result.text).not.toMatch(/which year/i);
  });

  it("does not mask a successful Outlook tool with the generic retry", async () => {
    const { runtime: exec } = runtime(() => ({
      mailboxAddress: "finance@elvexpropertyservices.com",
      messages: [{ subject: "Invoice pack", from: "ap@example.com", receivedDateTime: "2026-09-03T16:01:00Z" }],
    }));
    const result = await runIntelligenceTurn({
      text: "What is the newest email in the finance inbox?",
      state: buildConversationState({
        userText: "What is the newest email in the finance inbox?",
        connectors: ["conn_outlook_shared"],
      }),
      runtime: exec,
      completer: silentCompleter,
      channel: "portal",
    });
    expect(result.toolCalls[0]?.name).toBe("outlook_list_messages");
    expect(isGenericRetryCopy(result.text)).toBe(false);
    expect(result.text).toMatch(/Invoice pack/);
  });

  it("uses knowledge search not catalogue for sales plus payment process", async () => {
    const { runtime: exec, calls } = runtime((name) => {
      if (name === "search_company_knowledge") {
        return { results: [{ id: "doc_pay", title: "Subcontractor Payment Process", snippet: "PO number required." }] };
      }
      if (name.startsWith("warehouse_")) {
        return { sales_total: 12000, period: { fromDate: "2026-03-01", toDate: "2026-03-31" }, completeness: "COMPLETE" };
      }
      return { messages: [] };
    });
    const result = await runIntelligenceTurn({
      text: "What were March sales and what does our payment process say?",
      state: buildConversationState({
        userText: "What were March sales and what does our payment process say?",
        connectors: ["conn_xero", "conn_outlook_shared"],
        permittedTools: ["warehouse_sales_analysis", "search_company_knowledge", "list_documents", "xero_sales_summary"],
      }),
      runtime: exec,
      completer: silentCompleter,
      channel: "portal",
    });
    expect(calls.some((call) => call.name === "search_company_knowledge")).toBe(true);
    expect(calls.some((call) => call.name === "list_documents")).toBe(false);
    expect(calls.filter((call) => call.name === "search_company_knowledge")).toHaveLength(1);
    expect(isGenericRetryCopy(result.text)).toBe(false);
  });

  it("calls Xero once for sales this month", async () => {
    const { runtime: exec, calls } = runtime(() => ({
      source: "Xero",
      sales_total: 4554,
      invoice_count: 27,
      currencyCode: "GBP",
      period: { fromDate: "2026-09-01", toDate: "2026-09-04" },
    }));
    const result = await runIntelligenceTurn({
      text: "Xero sales this month",
      state: buildConversationState({
        userText: "Xero sales this month",
        connectors: ["conn_xero"],
      }),
      runtime: exec,
      completer: silentCompleter,
      channel: "portal",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("xero_sales_summary");
    expect(isGenericRetryCopy(result.text)).toBe(false);
    expect(result.text).toMatch(/4,554|4554/);
  });

  it("searches company knowledge for the PO process without extra tools", async () => {
    const { runtime: exec, calls } = runtime((name) => {
      if (name === "get_knowledge_document") {
        return {
          document_id: "doc_po",
          title: "Purchase order process",
          chunks: [{ id: "c0", text: "POs over £500 need two signatures." }],
        };
      }
      return {
        results: [{ id: "doc_po", title: "Purchase order process", snippet: "POs over £500 need two signatures." }],
      };
    });
    const result = await runIntelligenceTurn({
      text: "What is the PO process?",
      state: buildConversationState({ userText: "What is the PO process?" }),
      runtime: exec,
      completer: silentCompleter,
      channel: "portal",
    });
    expect(calls[0]?.name).toBe("search_company_knowledge");
    expect(calls.some((call) => call.name === "get_knowledge_document")).toBe(true);
    expect(isGenericRetryCopy(result.text)).toBe(false);
    expect(result.text).toMatch(/Purchase order process|two signatures/);
    expect(result.lastAnswerTopic).toBe("the PO process");
  });

  it("answers conversation memory from the last topic without searching", async () => {
    const { runtime: exec, calls } = runtime(() => {
      throw new Error("memory turns must not call tools");
    });
    const state = buildConversationState({
      userText: "What were we talking about?",
      lastAnswerTopic: "the PO process",
      lastAnswerText: "POs over £500 need two signatures.",
      lastUserIntent: "company_knowledge",
    });
    const more = await runIntelligenceTurn({
      text: "Give me more detail.",
      state: { ...state, lastUserText: "Give me more detail." },
      runtime: exec,
      completer: silentCompleter,
      channel: "portal",
    });
    const recall = await runIntelligenceTurn({
      text: "What were we talking about?",
      state,
      runtime: exec,
      completer: silentCompleter,
      channel: "portal",
    });
    expect(calls).toEqual([]);
    expect(more.scope).toBe("GENERAL_CONVERSATION");
    expect(more.text).toMatch(/two signatures|PO/i);
    expect(recall.text).toMatch(/PO process/i);
    expect(isGenericRetryCopy(more.text)).toBe(false);
    expect(isGenericRetryCopy(recall.text)).toBe(false);
  });

  it("surfaces truthful Outlook empty and upstream failures", async () => {
    const empty = await runIntelligenceTurn({
      text: "What is the newest email in the info inbox?",
      state: buildConversationState({ userText: "What is the newest email in the info inbox?" }),
      runtime: {
        async executeTool(call) {
          return { name: call.name, ok: true, latencyMs: 5, data: { mailboxAddress: "info@elvexpropertyservices.com", messages: [] } };
        },
      },
      completer: silentCompleter,
    });
    expect(empty.text).toMatch(/couldn.?t find any matching emails/i);
    const down = await runIntelligenceTurn({
      text: "What is the newest email in the info inbox?",
      state: buildConversationState({ userText: "What is the newest email in the info inbox?" }),
      runtime: {
        async executeTool(call) {
          return { name: call.name, ok: false, latencyMs: 5, data: { status: 502 }, error: "upstream" };
        },
      },
      completer: silentCompleter,
    });
    expect(down.text).toMatch(/couldn.?t reach Email/i);
    expect(isGenericRetryCopy(down.text)).toBe(false);
  });

  it("fetches the known message body on a content follow-up without relisting", async () => {
    const { runtime: exec, calls } = runtime((name) => {
      if (name === "outlook_get_message") {
        return {
          id: "msg_known",
          subject: "Leak detection quote",
          from: "ops@example.com",
          receivedDateTime: "2026-09-04T09:00:00Z",
          body: "Please confirm availability for a leak survey next Tuesday.",
        };
      }
      return {
        mailboxAddress: "info@elvexpropertyservices.com",
        messages: [{ id: "msg_other", subject: "Unrelated", from: "other@example.com", receivedDateTime: "2026-09-04T10:00:00Z" }],
      };
    });
    const result = await runIntelligenceTurn({
      text: "What do they want from us?",
      state: buildConversationState({
        userText: "What do they want from us?",
        lastAnswerTopic: "email",
        currentBusinessSystem: "email",
        lastSuccessfulTool: "outlook_list_messages",
        connectors: ["conn_outlook_shared"],
        permittedTools: ["outlook_list_messages", "outlook_search_mailbox", "outlook_get_message", "search_company_knowledge"],
        recentEvidence: {
          companyId: "co_el",
          source: "outlook",
          capturedAt: "2026-09-05T08:00:00.000Z",
          recentEmail: {
            id: "msg_known",
            subject: "Leak detection quote",
            from: "ops@example.com",
            receivedDateTime: "2026-09-04T09:00:00Z",
            mailboxAddress: "info@elvexpropertyservices.com",
            body: "",
            toolName: "outlook_list_messages",
          },
          recentXero: null,
          recentDocument: null,
          recentCatalogueItem: null,
          lastSuccessfulCalls: [{ name: "outlook_list_messages", argsHash: "outlook_list_messages:", summary: "listed" }],
        },
      }),
      runtime: exec,
      completer: silentCompleter,
      channel: "portal",
    });
    expect(calls.map((call) => call.name)).toEqual(["outlook_get_message"]);
    expect(calls[0]?.arguments.messageId ?? calls[0]?.arguments.id).toBe("msg_known");
    expect(result.text).toMatch(/leak survey|availability/i);
  });
});
