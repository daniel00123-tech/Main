import { describe, expect, it } from "vitest";
import { classifyScope, detectNamedDocumentSwitch } from "./scope.js";
import { buildConversationState } from "./state.js";
import { runIntelligenceTurn } from "./orchestrator.js";
import { resolveBusinessPeriod, withResolvedBusinessDates } from "./periods.js";
import { enrichDocumentQuery } from "./query-enrichment.js";
import { verbaliseSystemMeta } from "./system-meta.js";
import { queryTerms, scoreGlobalSearchHit, searchDocument, type DocumentChunk } from "../whatsapp-grounded-qa.js";
import { evaluationCases } from "./eval/cases.js";
import type { IntelligenceRuntime, IntelligenceToolResult } from "./types.js";

const CV = { id: "doc_profile_2015", title: "Staff profile", url: "https://docs.example.test/profile" };
const VAN = { id: "doc_vehicle_policy", title: "Vehicle use policy", url: "https://docs.example.test/vehicle" };
const SITE = { id: "doc_site_survey", title: "Site survey report", url: "https://files.example.test/survey.pdf" };

function recordingRuntime(handler?: (name: string, args: Record<string, unknown>) => unknown): {
  runtime: IntelligenceRuntime;
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  return {
    calls,
    runtime: {
      async executeTool(call): Promise<IntelligenceToolResult> {
        calls.push({ name: call.name, arguments: call.arguments });
        const data = handler?.(call.name, call.arguments) ?? { ok: true };
        return { name: call.name, ok: true, latencyMs: 2, data };
      },
    },
  };
}

describe("document switch while another file is open", () => {
  it("routes a named different title to company knowledge instead of the current file", () => {
    const state = buildConversationState({
      userText: "Open the vehicle handbook",
      currentDocument: CV,
      lastAnswerTopic: "document",
      currentScope: "CURRENT_DOCUMENT",
    });
    const decision = classifyScope("Open the vehicle handbook", state);
    expect(decision.scope).toBe("COMPANY_KNOWLEDGE");
    expect(decision.tool).toBe("search_company_knowledge");
    expect(decision.clearCurrentDocument).toBe(true);
  });

  it("keeps pronoun follow-ups on the current document", () => {
    const state = buildConversationState({
      userText: "What about him?",
      currentDocument: CV,
      lastAnswerTopic: "document",
      currentScope: "CURRENT_DOCUMENT",
    });
    expect(classifyScope("What about him?", state).scope).toBe("CURRENT_DOCUMENT");
    expect(classifyScope("When was that?", state).scope).toBe("CURRENT_DOCUMENT");
  });

  it("restores a remembered title only when two title tokens hit", () => {
    const state = buildConversationState({
      userText: "Switch to the site survey report",
      currentDocument: CV,
      recentDocuments: [SITE],
      entities: [CV, VAN, SITE],
    });
    const named = detectNamedDocumentSwitch("Switch to the site survey report", state);
    expect(named?.target).toBe("recent");
    expect(named?.matchedDocument?.id).toBe(SITE.id);
    expect(detectNamedDocumentSwitch("Open the vehicle handbook", state)?.target).toBe("company");
  });

  it("does not treat open-the-source as a document switch", () => {
    const state = buildConversationState({
      userText: "Open the source",
      currentDocument: CV,
      lastAnswerTopic: "document",
    });
    expect(detectNamedDocumentSwitch("Open the source", state)).toBeNull();
    expect(classifyScope("Open the source", state).scope).toBe("CURRENT_DOCUMENT");
  });
});

describe("Xero natural periods", () => {
  it("maps this month to Europe/London month-to-date, never empty dates", () => {
    const now = new Date("2026-08-30T12:00:00.000Z");
    const period = resolveBusinessPeriod("What were sales this month?", now);
    expect(period.fromDate).toBe("2026-08-01");
    expect(period.toDate).toBe("2026-08-30");
    expect(period.fromDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(period.toDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("handles week, quarter, year, yesterday, and past-N-day bounds", () => {
    const now = new Date("2026-08-30T12:00:00.000Z");
    expect(resolveBusinessPeriod("sales yesterday", now)).toMatchObject({ fromDate: "2026-08-29", toDate: "2026-08-29" });
    expect(resolveBusinessPeriod("sales last month", now)).toMatchObject({ fromDate: "2026-07-01", toDate: "2026-07-31" });
    expect(resolveBusinessPeriod("sales this quarter", now)).toMatchObject({ fromDate: "2026-07-01", toDate: "2026-08-30" });
    expect(resolveBusinessPeriod("sales last quarter", now)).toMatchObject({ fromDate: "2026-04-01", toDate: "2026-06-30" });
    expect(resolveBusinessPeriod("sales this year", now)).toMatchObject({ fromDate: "2026-01-01", toDate: "2026-08-30" });
    expect(resolveBusinessPeriod("past 7 days sales", now)).toMatchObject({ fromDate: "2026-08-24", toDate: "2026-08-30" });
    expect(resolveBusinessPeriod("past 30 days revenue", now)).toMatchObject({ fromDate: "2026-08-01", toDate: "2026-08-30" });
    const week = resolveBusinessPeriod("sales this week", now);
    expect(week.fromDate).toBe("2026-08-24");
    expect(week.toDate).toBe("2026-08-30");
  });

  it("marks sales-summary comparisons as unsupported and P&L as supported", () => {
    const now = new Date("2026-08-30T12:00:00.000Z");
    const period = resolveBusinessPeriod("Compare this month with last month", now);
    expect(period.comparisonRequested).toBe(true);
    expect(period.comparison).toMatchObject({ fromDate: "2026-07-01", toDate: "2026-07-31" });
    const sales = withResolvedBusinessDates("xero_sales_summary", {}, "Compare this month with last month", now);
    expect(sales.comparisonSupported).toBe(false);
    expect(sales.fromDate).toBe("2026-08-01");
    const pnl = withResolvedBusinessDates("xero_profit_and_loss", {}, "Compare this month with last month", now);
    expect(pnl.comparisonSupported).toBe(true);
    expect(pnl.periods).toBe(2);
    expect(pnl.timeframe).toBe("MONTH");
  });

  it("passes real dates on the intelligence Xero path", async () => {
    const { runtime, calls } = recordingRuntime();
    await runIntelligenceTurn({
      text: "What were sales this month?",
      state: buildConversationState({ userText: "What were sales this month?", connectors: ["conn_xero"] }),
      runtime,
    });
    expect(calls[0]?.name).toBe("xero_sales_summary");
    expect(String(calls[0]?.arguments.fromDate ?? "")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(String(calls[0]?.arguments.toDate ?? "")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(calls[0]?.arguments.fromDate).not.toBe("");
    expect(calls[0]?.arguments.toDate).not.toBe("");
  });
});

describe("Drive count honesty", () => {
  it("does not say Drive is missing when it is connected without a reliable count", () => {
    const text = verbaliseSystemMeta(
      "get_document_index_stats",
      {
        totalIndexed: 9,
        bySource: [{ source: "SharePoint", count: 9 }],
        byType: [],
        lastSyncAt: null,
        driveConnected: true,
        driveCountReliable: false,
        connectedSystems: ["Google Drive files", "SharePoint"],
      },
      "How many files are indexed?",
    );
    expect(text).toMatch(/9/);
    expect(text).toMatch(/Google Drive is connected/i);
    expect(text).not.toMatch(/Drive is missing|not connected|don't have Drive/i);
    expect(text).toMatch(/won't guess a combined total|don't have a reliable Drive/i);
  });

  it("never invents a combined total when only Microsoft counts are real", () => {
    const text = verbaliseSystemMeta(
      "get_document_index_stats",
      {
        totalIndexed: 9,
        bySource: [{ source: "SharePoint", count: 9 }],
        driveConnected: true,
        connectedSystems: ["Google Drive files"],
      },
      "How many Drive files are there?",
    );
    expect(text).not.toMatch(/\b1[0-9]\b/);
    expect(text).toMatch(/reliable Drive file count/i);
  });
});

describe("short follow-up ranking", () => {
  it("enriches CURRENT_DOCUMENT queries with fewer than two distinctive terms", () => {
    const result = enrichDocumentQuery("When?", {
      scope: "CURRENT_DOCUMENT",
      currentTitle: "Vehicle use policy",
      previousUserText: "What are the main rules for returning the vehicle?",
      lastAnswerTopic: "document",
    });
    expect(result.enriched).toBe(true);
    expect(result.terms.length).toBeGreaterThanOrEqual(2);
    expect(queryTerms("When?").length).toBeLessThan(2);
  });

  it("decays enrichment after a correction or subject change", () => {
    const result = enrichDocumentQuery("When?", {
      scope: "CURRENT_DOCUMENT",
      currentTitle: "Vehicle use policy",
      previousUserText: "What are the main rules?",
      lastAnswerTopic: "document",
      userCorrection: true,
    });
    expect(result.decayed).toBe(true);
    expect(result.enriched).toBe(false);
  });

  it("does not lower the global title ranking for an exact title vs a coincidence", () => {
    const exact = scoreGlobalSearchHit({ title: "North yard induction pack", snippet: "site rules" }, "north yard induction pack");
    const weak = scoreGlobalSearchHit({ title: "Random policy note", snippet: "north of the yard there is a pack" }, "north yard induction pack");
    expect(exact).toBeGreaterThan(weak);
    expect(exact).toBeGreaterThanOrEqual(8);
  });

  it("does not give every chunk the same useful rank once a short follow-up is enriched", () => {
    const chunks: DocumentChunk[] = [
      { id: "c0", documentId: "d1", text: "Drivers record fuel weekly and keep receipts.", heading: "Fuel", index: 0 },
      { id: "c1", documentId: "d1", text: "The canteen menu changes on Fridays.", heading: "Welfare", index: 1 },
    ];
    const empty = searchDocument("d1", "When?", chunks);
    expect(empty.every((row) => row.score === 1) || empty.length === 2).toBe(true);
    const enriched = enrichDocumentQuery("When?", {
      scope: "CURRENT_DOCUMENT",
      currentTitle: "Vehicle use policy",
      previousUserText: "What about fuel cards and receipts?",
      lastAnswerTopic: "document",
    });
    const ranked = searchDocument("d1", enriched.query, chunks);
    expect(ranked[0]?.id).toBe("c0");
    expect(ranked[0]!.score).toBeGreaterThan(ranked.find((row) => row.id === "c1")?.score ?? 0);
  });
});

describe("eval harness size", () => {
  it("covers at least 250 cases", () => {
    expect(evaluationCases().length).toBeGreaterThanOrEqual(250);
  });
});
