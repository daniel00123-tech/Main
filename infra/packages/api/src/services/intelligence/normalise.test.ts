import { describe, expect, it } from "vitest";
import { composeInfraXeroReadResult } from "../xero-company-mcp";
import { runIntelligenceTurn } from "./orchestrator.js";
import { buildConversationState } from "./state.js";
import { summariseXeroEvidence } from "./evidence.js";
import {
  compactBusinessToolData,
  equivalentToolArgs,
  isSufficientBusinessResult,
  normaliseBusinessResult,
} from "./normalise.js";
import type { IntelligenceRuntime, IntelligenceToolResult } from "./types.js";

const LIVE_XERO_SHAPE = composeInfraXeroReadResult(
  "xero_sales_summary",
  { fromDate: "2026-09-01", toDate: "2026-09-30", periodLabel: "this month" },
  {
    invoices: [
      { InvoiceNumber: "INV-200", Type: "ACCREC", Status: "AUTHORISED", Total: 18450.5, Contact: { Name: "Acme" } },
      { InvoiceNumber: "INV-201", Type: "ACCREC", Status: "AUTHORISED", Total: 2100, Contact: { Name: "Beta" } },
    ],
    currencyCode: "GBP",
  },
  "search_xero_invoices",
);

function recordingRuntime(data: unknown): {
  runtime: IntelligenceRuntime;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    runtime: {
      async executeTool(call): Promise<IntelligenceToolResult> {
        calls.push(call.name);
        return { name: call.name, ok: true, latencyMs: 3, data };
      },
    },
  };
}

describe("structured business result normalisation", () => {
  it("reads live company-MCP Xero fields (sales_total / totalSales / invoice_count)", () => {
    const normalised = normaliseBusinessResult("xero_sales_summary", LIVE_XERO_SHAPE);
    expect(normalised.sufficient).toBe(true);
    expect(normalised.amount).toBe(20550.5);
    expect(normalised.invoiceCount).toBe(2);
    expect(normalised.period).toMatch(/this month|2026-09-01 to 2026-09-30/);
    expect(normalised.currency).toBe("GBP");
    expect(normalised.summaryText).toMatch(/£20,550\.50/);
    expect(normalised.summaryText).toMatch(/2 invoices/);
    expect(summariseXeroEvidence(LIVE_XERO_SHAPE)).not.toMatch(/I reached Xero/i);
  });

  it("still reads the older summary.total shape", () => {
    const normalised = normaliseBusinessResult("xero_sales_summary", {
      summary: { total: 99, invoiceCount: 2, currency: "GBP", fromDate: "2026-09-01" },
    });
    expect(normalised.amount).toBe(99);
    expect(normalised.invoiceCount).toBe(2);
    expect(normalised.summaryText).toMatch(/£99\.00/);
  });

  it("treats one newest Outlook message as sufficient", () => {
    const normalised = normaliseBusinessResult("outlook_list_messages", {
      mailboxAddress: "info@elvexpropertyservices.com",
      messages: [{ subject: "Site visit", from: "a@example.com", receivedDateTime: "2026-09-03T09:00:00Z" }],
    });
    expect(normalised.sufficient).toBe(true);
    expect(normalised.subject).toBe("Site visit");
    expect(normalised.summaryText).toMatch(/Site visit/);
  });

  it("keeps structured Xero fields when the raw payload is huge", () => {
    const huge = {
      ...LIVE_XERO_SHAPE,
      transactions: Array.from({ length: 80 }, (_, i) => ({ id: `tx${i}`, total: 10, note: "x".repeat(80) })),
    };
    const compact = compactBusinessToolData("xero_sales_summary", huge) as Record<string, unknown>;
    expect(compact.amount).toBe(20550.5);
    expect(compact.invoice_count).toBe(2);
    expect(JSON.stringify(compact).length).toBeLessThan(2_000);
  });

  it("treats equivalent Xero date args as the same call", () => {
    expect(
      equivalentToolArgs(
        "xero_sales_summary",
        { fromDate: "2026-09-01", toDate: "2026-09-30", extra: 1 },
        { fromDate: "2026-09-01", toDate: "2026-09-30" },
      ),
    ).toBe(true);
  });
});

describe("first-turn synthesis and duplicate suppression", () => {
  it("answers Xero sales from the structured payload without a second tool call", async () => {
    const { runtime, calls } = recordingRuntime(LIVE_XERO_SHAPE);
    const result = await runIntelligenceTurn({
      text: "What are our Xero sales this month?",
      state: buildConversationState({
        userText: "What are our Xero sales this month?",
        connectors: ["conn_xero"],
        permittedTools: ["xero_sales_summary"],
      }),
      runtime,
      completer: async () => ({
        text: JSON.stringify({ action: "answer", text: "I reached Xero. Ask for overdue invoices.", confidence: "partial" }),
        usage: { provider: "none", model: null, latencyMs: 1, promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 },
      }),
    });
    expect(calls.filter((name) => name === "xero_sales_summary")).toHaveLength(1);
    expect(result.text).toMatch(/£20,550\.50/);
    expect(result.text).toMatch(/2 invoices/);
    expect(result.text).not.toMatch(/I reached Xero/i);
    expect(result.text).not.toMatch(/I need another moment/i);
    expect(isSufficientBusinessResult(result.toolCalls[0]!)).toBe(true);
  });

  it("does not execute the same successful business tool twice in one turn", async () => {
    let step = 0;
    const { runtime, calls } = recordingRuntime(LIVE_XERO_SHAPE);
    const result = await runIntelligenceTurn({
      text: "What are our Xero sales this month?",
      state: buildConversationState({
        userText: "What are our Xero sales this month?",
        connectors: ["conn_xero"],
        permittedTools: ["xero_sales_summary"],
      }),
      runtime,
      completer: async () => {
        step += 1;
        return {
          text: JSON.stringify({ action: "call_tool", name: "xero_sales_summary", arguments: {} }),
          usage: { provider: "none", model: null, latencyMs: 1, promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 },
        };
      },
    });
    expect(calls.filter((name) => name === "xero_sales_summary")).toHaveLength(1);
    expect(result.toolCalls.filter((call) => call.ok && call.name === "xero_sales_summary")).toHaveLength(1);
    expect(result.text).toMatch(/£20,550\.50/);
    expect(step).toBeGreaterThanOrEqual(0);
  });

  it("reuses prior evidence for More Detail after a useful first answer", async () => {
    const { runtime, calls } = recordingRuntime(LIVE_XERO_SHAPE);
    const result = await runIntelligenceTurn({
      text: "give me more detail",
      state: buildConversationState({
        userText: "give me more detail",
        lastAnswerTopic: "finance",
        lastAnswerText: "Xero sales for this month are £20,550.50 across 2 invoices.",
        lastSuccessfulTool: "xero_sales_summary",
        recentTurns: [
          { role: "user", text: "What are our Xero sales this month?" },
          { role: "assistant", text: "Xero sales for this month are £20,550.50 across 2 invoices." },
        ],
        connectors: ["conn_xero"],
      }),
      runtime,
    });
    expect(calls).toEqual([]);
    expect(result.text).toMatch(/£20,550\.50/);
    expect(result.scope).toBe("GENERAL_CONVERSATION");
    expect(result.lastUserIntent).toBe("more_detail");
  });
});
