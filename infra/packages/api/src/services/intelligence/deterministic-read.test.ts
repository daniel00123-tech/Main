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
    expect(empty.text).toMatch(/couldn.?t find any matching emails|No matching messages in info@/i);
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
});
