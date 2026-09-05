import { describe, expect, it } from "vitest";
import { runIntelligenceTurn } from "./orchestrator.js";
import { resolveBrainPolicy } from "./brain-policy.js";
import { buildConversationState } from "./state.js";
import type { IntelligenceCompleter } from "./provider.js";
import type { IntelligenceRuntime, IntelligenceToolResult } from "./types.js";

const PRIMARY_ENV = {
  OPENAI_API_KEY: "sk-test-key-1234567890abcdef",
  OPENAI_BRAIN_ENABLED: "true",
  OPENAI_BRAIN_MODE: "openai_primary",
  OPENAI_BRAIN_COMPANY_IDS: "co_el,co_caddington",
};

function planner(name: string, args: Record<string, unknown> = {}): IntelligenceCompleter {
  let round = 0;
  return async () => {
    round += 1;
    if (round === 1) {
      return {
        text: JSON.stringify({ action: "call_tool", name, arguments: args }),
        usage: {
          provider: "openai",
          model: "gpt-test-planner",
          latencyMs: 12,
          promptTokens: 40,
          completionTokens: 16,
          estimatedCostUsd: 0.001,
        },
        toolCalls: [{ name, arguments: args }],
      };
    }
    return {
      text: JSON.stringify({
        action: "answer",
        text: "Grounded answer from authorised evidence.",
        confidence: "strong",
        offer_search_other: false,
        cite_source: false,
      }),
      usage: {
        provider: "openai",
        model: "gpt-test-synthesis",
        latencyMs: 9,
        promptTokens: 30,
        completionTokens: 20,
        estimatedCostUsd: 0.001,
      },
    };
  };
}

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

describe("openai primary agentic planner", () => {
  it("makes OpenAI the user-visible brain for EL and Caddington PA/request while HT stays Cloudflare", () => {
    const el = resolveBrainPolicy({ env: PRIMARY_ENV, companyId: "co_el", channel: "whatsapp" });
    expect(el.mode).toBe("openai_primary");
    expect(el.useOpenAi).toBe(true);
    expect(el.userVisibleBrain).toBe("openai");
    expect(el.reason).toBe("openai_primary");
    const cad = resolveBrainPolicy({ env: PRIMARY_ENV, companyId: "co_caddington", channel: "portal_chat" });
    expect(cad.mode).toBe("openai_primary");
    expect(cad.userVisibleBrain).toBe("openai");
    expect(resolveBrainPolicy({ env: PRIMARY_ENV, companyId: "co_el" }).useOpenAi).toBe(false);
    expect(resolveBrainPolicy({ env: PRIMARY_ENV, companyId: "co_el" }).userVisibleBrain).toBe("cloudflare");
    expect(resolveBrainPolicy({ env: PRIMARY_ENV, companyId: "co_ht", channel: "whatsapp" }).useOpenAi).toBe(false);
    expect(resolveBrainPolicy({ env: PRIMARY_ENV, companyId: "co_el", channel: "chatgpt" }).useOpenAi).toBe(false);
  });

  it("does not phrase-force web search before the OpenAI planner", async () => {
    const { runtime: exec, calls } = runtime(() => ({
      source: "public_web",
      heading: "London weather",
      abstract: "Mild, 16C, light rain.",
      results: [{ title: "Met Office", snippet: "Light rain tomorrow.", url: "https://www.metoffice.gov.uk" }],
    }));
    const result = await runIntelligenceTurn({
      env: PRIMARY_ENV,
      text: "What's the weather tomorrow?",
      channel: "portal_chat",
      completer: planner("web_search", { query: "weather tomorrow London" }),
      state: buildConversationState({
        userText: "What's the weather tomorrow?",
        companyId: "co_el",
        connectors: ["conn_xero", "conn_outlook_shared"],
        permittedTools: ["web_search", "search_company_knowledge", "warehouse_sales_analysis"],
      }),
      runtime: exec,
    });
    expect(result.brainMode).toBe("openai_primary");
    expect(result.userVisibleBrain).toBe("openai");
    expect(result.plannerProvider).toBe("openai");
    expect(result.synthesisProvider).toBe("openai");
    expect(result.modelRounds[0]?.provider).toBe("openai");
    expect(result.modelRounds.at(-1)?.provider).toBe("openai");
    expect(calls[0]?.name).toBe("web_search");
    expect(calls.some((call) => call.name === "search_company_knowledge")).toBe(false);
    expect(result.text).toMatch(/authorised evidence|Mild|rain/i);
  });

  it("lets the planner choose warehouse for historical sales instead of a phrase map", async () => {
    const { runtime: exec, calls } = runtime(() => ({
      sales_total: 23434.6,
      invoice_count: 85,
      fromDate: "2026-03-01",
      toDate: "2026-03-31",
      completeness_status: "COMPLETE",
    }));
    const result = await runIntelligenceTurn({
      env: PRIMARY_ENV,
      text: "What were our sales in March?",
      channel: "whatsapp",
      completer: planner("warehouse_sales_analysis", { fromDate: "2026-03-01", toDate: "2026-03-31" }),
      state: buildConversationState({
        userText: "What were our sales in March?",
        companyId: "co_el",
        connectors: ["conn_xero"],
        permittedTools: ["warehouse_sales_analysis", "xero_sales_summary", "web_search"],
      }),
      runtime: exec,
    });
    expect(result.plannerProvider).toBe("openai");
    expect(result.synthesisProvider).toBe("openai");
    expect(calls[0]?.name).toBe("warehouse_sales_analysis");
    expect(result.fallbackUsed).toBeFalsy();
  });

  it("continues after an insufficient first route instead of stopping at no-results", async () => {
    let knowledge = 0;
    const { runtime: exec, calls } = runtime((name) => {
      if (name === "search_company_knowledge") {
        knowledge += 1;
        return { results: [] };
      }
      return {
        documents: [{ id: "doc_price", title: "Approved pricing schedule", snippet: "Labour and material rules." }],
      };
    });
    let round = 0;
    const completer: IntelligenceCompleter = async () => {
      round += 1;
      if (round === 1) {
        return {
          text: JSON.stringify({ action: "call_tool", name: "search_company_knowledge", arguments: { query: "unicorn handbook" } }),
          usage: { provider: "openai", model: "gpt-test-planner", latencyMs: 8, promptTokens: 12, completionTokens: 8, estimatedCostUsd: 0 },
        };
      }
      if (round === 2) {
        return {
          text: JSON.stringify({ action: "call_tool", name: "list_documents", arguments: { query: "handbook" } }),
          usage: { provider: "openai", model: "gpt-test-planner", latencyMs: 8, promptTokens: 12, completionTokens: 8, estimatedCostUsd: 0 },
        };
      }
      return {
        text: JSON.stringify({
          action: "answer",
          text: "Knowledge search had no match. The document catalogue has an Approved pricing schedule, which is the next permitted source.",
          confidence: "partial",
          offer_search_other: false,
          cite_source: false,
        }),
        usage: { provider: "openai", model: "gpt-test-synthesis", latencyMs: 8, promptTokens: 12, completionTokens: 18, estimatedCostUsd: 0 },
      };
    };
    const result = await runIntelligenceTurn({
      env: PRIMARY_ENV,
      text: "Find the unicorn onboarding handbook and, if it is missing, use another permitted business source.",
      channel: "portal",
      completer,
      state: buildConversationState({
        userText: "Find the unicorn onboarding handbook and, if it is missing, use another permitted business source.",
        companyId: "co_caddington",
        connectors: ["conn_xero", "conn_google_drive"],
        permittedTools: ["search_company_knowledge", "list_documents", "web_search"],
      }),
      runtime: exec,
    });
    expect(knowledge).toBe(1);
    expect(calls.map((call) => call.name)).toEqual(["search_company_knowledge", "list_documents"]);
    expect(result.plannerProvider).toBe("openai");
    expect(result.synthesisProvider).toBe("openai");
    expect(result.text).toMatch(/catalogue|pricing schedule/i);
    expect(result.text).not.toMatch(/^I cannot find that\.?$/i);
  });

  it("keeps writes on the deterministic controlled-action path", async () => {
    const { runtime: exec, calls } = runtime(() => ({}));
    const result = await runIntelligenceTurn({
      env: PRIMARY_ENV,
      text: "Create an invoice in Xero for £50",
      channel: "portal_chat",
      completer: planner("xero_sales_summary"),
      state: buildConversationState({
        userText: "Create an invoice in Xero for £50",
        companyId: "co_el",
        connectors: ["conn_xero"],
        permittedTools: ["xero_sales_summary"],
      }),
      runtime: exec,
    });
    expect(result.route).toBe("CONTROLLED_ACTION");
    expect(calls).toHaveLength(0);
  });
});
