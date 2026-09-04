import { describe, expect, it } from "vitest";
import { classifyTurnFailures, clusterKey } from "./failure-telemetry.js";
import { persistEngineeringFailures, shouldOpenEngineeringWorkItem, toWorkItem } from "./dev-failure-queue.js";
import type { IntelligenceTurnResult } from "./types.js";

function turn(overrides: Partial<IntelligenceTurnResult> = {}): IntelligenceTurnResult {
  return {
    kind: "failed",
    text: "",
    confidence: "none",
    offerSearchOther: false,
    toolCalls: [],
    currentDocument: null,
    evidenceDocumentIds: [],
    clarification: false,
    citeSource: false,
    modelRounds: [],
    totalModelMs: 10,
    totalToolMs: 5,
    provider: "openai",
    model: "gpt-test",
    estimatedCostUsd: 0,
    ...overrides,
  };
}

describe("failure telemetry and supervisor clustering", () => {
  it("records QUALITY_GUARD_REPAIR and TOOL_FAILED without secret content", () => {
    const events = classifyTurnFailures({
      question: "sales",
      companyId: "co_el",
      channel: "portal",
      result: turn({
        repaired: true,
        guardChecks: [{ id: "not_blank", ok: false }],
        toolCalls: [{ name: "xero_sales_summary", ok: false, latencyMs: 12, data: null, error: "timeout" }],
      }),
    });
    expect(events.some((event) => event.category === "QUALITY_GUARD_REPAIR")).toBe(true);
    expect(events.some((event) => event.category === "UPSTREAM_TIMEOUT")).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/sk-|password|Bearer /);
  });

  it("clusters twenty email follow-up failures into one key", () => {
    const keys = Array.from({ length: 20 }, () =>
      clusterKey({
        category: "EVIDENCE_DROPPED",
        capability: "outlook",
        tool: "outlook_list_messages",
        companyId: "co_el",
      }),
    );
    expect(new Set(keys).size).toBe(1);
    expect(shouldOpenEngineeringWorkItem(20)).toBe(true);
    expect(shouldOpenEngineeringWorkItem(1)).toBe(false);
    const item = toWorkItem({
      cluster_key: keys[0]!,
      category: "EVIDENCE_DROPPED",
      capability: "outlook",
      tool_name: "outlook_list_messages",
      occurrence_count: 20,
      status: "clustered",
      sample_correlation_id: "intel_test",
      first_seen_at: "2026-09-04T00:00:00Z",
      last_seen_at: "2026-09-04T01:00:00Z",
    });
    expect(item.autoDeploy).toBe(false);
    expect(item.reproducible).toBe(true);
  });

  it("persists events into the async queue", async () => {
    const rows: unknown[] = [];
    const clusters = new Map<string, { occurrence_count: number; status: string; first_seen_at: string }>();
    const db = {
      prepare(query: string) {
        return {
          bind(...values: unknown[]) {
            return this;
          },
          async run() {
            if (/INSERT OR IGNORE INTO engineering_failure_events/.test(query)) rows.push(query);
            return {};
          },
          async first() {
            if (/SELECT occurrence_count/.test(query)) return null;
            return null;
          },
          async all() {
            return { results: [] };
          },
        };
      },
    };
    void clusters;
    const events = classifyTurnFailures({
      question: "x",
      companyId: "co_el",
      result: turn({ qualityFlags: ["wrong_tool"] }),
    });
    const stored = await persistEngineeringFailures(db, events);
    expect(stored.stored).toBeGreaterThan(0);
  });

  it("records EXPECTED_TOOL_MISSING, FIRST_ANSWER_INCOMPLETE, and DUPLICATE_TOOL", () => {
    const missing = classifyTurnFailures({
      question: "What are our Xero sales this month?",
      companyId: "co_el",
      result: turn({
        kind: "answer",
        text: "I can look that up.",
        lastAnswerTopic: null,
        toolCalls: [],
      }),
    });
    expect(missing.some((event) => event.category === "EXPECTED_TOOL_MISSING")).toBe(true);

    const incomplete = classifyTurnFailures({
      question: "sales this month",
      result: turn({
        kind: "answer",
        text: "Can you give me a little more detail so I look in the right place?",
        toolCalls: [{ name: "xero_sales_summary", ok: true, latencyMs: 8, data: { sales_total: 5094 } }],
      }),
    });
    expect(incomplete.some((event) => event.category === "FIRST_ANSWER_INCOMPLETE")).toBe(true);

    const dupes = classifyTurnFailures({
      question: "sales",
      result: turn({
        kind: "answer",
        text: "Sales are £5,094.",
        toolCalls: [
          { name: "xero_sales_summary", ok: true, latencyMs: 4, data: { sales_total: 5094 } },
          { name: "xero_sales_summary", ok: true, latencyMs: 4, data: { sales_total: 5094 } },
        ],
      }),
    });
    expect(dupes.some((event) => event.category === "DUPLICATE_TOOL")).toBe(true);
  });
});
