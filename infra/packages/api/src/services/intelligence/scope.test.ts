import { describe, expect, it } from "vitest";
import { classifyScope, isCorpusInventoryAsk } from "./scope.js";
import { scopeEvaluationCases } from "./eval/scope-cases.js";
import { buildConversationState } from "./state.js";
import { runIntelligenceTurn } from "./orchestrator.js";
import { verbaliseSystemMeta, inventedCount, resetSystemMetaCache, loadDocumentIndexStats } from "./system-meta.js";
import type { IntelligenceRuntime, IntelligenceToolResult } from "./types.js";

describe("scope classifier", () => {
  it("routes newest-inbox asks to list, not semantic search", () => {
    for (const text of [
      "What is the newest email in the info inbox?",
      "What is the newest email in the finance inbox?",
    ]) {
      const decision = classifyScope(text, buildConversationState({ userText: text }));
      expect(decision.scope).toBe("BUSINESS_SYSTEM");
      expect(decision.tool).toBe("outlook_list_messages");
    }
  });

  it("ranks explicit Xero data questions as BUSINESS_SYSTEM", () => {
    for (const text of [
      "tell me on xero what our sales are",
      "what are our Xero sales this month?",
      "show me invoices raised today",
      "what is outstanding in Xero?",
    ]) {
      const decision = classifyScope(text, buildConversationState({ userText: text }));
      expect(decision.scope).toBe("BUSINESS_SYSTEM");
      expect(decision.tool?.startsWith("xero_")).toBe(true);
    }
  });

  it("covers at least 120 unseen prompts and exceeds 95% scope accuracy", () => {
    const cases = scopeEvaluationCases();
    expect(cases.length).toBeGreaterThanOrEqual(120);
    let hits = 0;
    const misses: string[] = [];
    for (const testCase of cases) {
      const decision = classifyScope(testCase.text, testCase.state ?? buildConversationState({ userText: testCase.text }));
      const ok =
        decision.scope === testCase.intendedScope &&
        (testCase.intendedTool == null || decision.tool === testCase.intendedTool || decision.clarify === testCase.clarify) &&
        (testCase.clarify ? decision.clarify : true);
      if (ok) hits += 1;
      else {
        misses.push(
          `${testCase.id} "${testCase.text}" intended=${testCase.intendedScope}/${testCase.intendedTool} got=${decision.scope}/${decision.tool} clarify=${decision.clarify}`,
        );
      }
    }
    const accuracy = hits / cases.length;
    if (accuracy < 0.95) {
      throw new Error(`Scope accuracy ${(accuracy * 100).toFixed(1)}%\n${misses.slice(0, 20).join("\n")}`);
    }
    expect(accuracy).toBeGreaterThan(0.95);
  });

  it("treats inventory of the corpus as system meta even with a current document", () => {
    const state = buildConversationState({
      userText: "How many files are there on the system?",
      currentDocument: { id: "doc_cv", title: "Staff profile" },
    });
    const decision = classifyScope("How many files are there on the system?", state);
    expect(decision.scope).toBe("SYSTEM_META");
    expect(decision.tool).toBe("get_document_index_stats");
    expect(decision.tool).not.toBe("search_document");
  });

  it("keeps mention-counts company-wide unless the current file is named", () => {
    const open = buildConversationState({
      userText: "How many files mention vans?",
      currentDocument: { id: "doc_cv", title: "Staff profile" },
    });
    expect(classifyScope("How many files mention vans?", open).scope).toBe("COMPANY_KNOWLEDGE");
    expect(classifyScope("How many times does this document mention vans?", open).scope).toBe("CURRENT_DOCUMENT");
  });

  it("does not treat inventory questions as generic document hunts", () => {
    expect(isCorpusInventoryAsk("How many files are there on the system?")).toBe(true);
    expect(isCorpusInventoryAsk("find the vehicle policy")).toBe(false);
  });

  it("switches away from the open file when a different named title is requested", () => {
    const open = buildConversationState({
      userText: "Open the vehicle handbook",
      currentDocument: { id: "doc_cv", title: "Staff profile" },
      lastAnswerTopic: "document",
      currentScope: "CURRENT_DOCUMENT",
    });
    const decision = classifyScope("Open the vehicle handbook", open);
    expect(decision.scope).toBe("COMPANY_KNOWLEDGE");
    expect(decision.clearCurrentDocument).toBe(true);
    expect(classifyScope("What about him?", open).scope).toBe("CURRENT_DOCUMENT");
  });

  it("routes EL WhatsApp business-system prompts away from Xero when they are email or process", () => {
    expect(classifyScope("Search emails", buildConversationState({ userText: "Search emails" })).tool).toBe(
      "outlook_search_mailbox",
    );
    expect(
      classifyScope(
        "How many emails has Sharon sent today?",
        buildConversationState({ userText: "How many emails has Sharon sent today?" }),
      ).tool,
    ).toBe("outlook_search_mailbox");
    expect(classifyScope("What is the PO process?", buildConversationState({ userText: "What is the PO process?" })).tool).not.toMatch(
      /^xero_/,
    );
    expect(
      classifyScope("Tell me Xero sales this month.", buildConversationState({ userText: "Tell me Xero sales this month." }))
        .tool,
    ).toMatch(/^xero_/);
    expect(
      classifyScope(
        "Find the newest OneDrive document.",
        buildConversationState({ userText: "Find the newest OneDrive document." }),
      ).tool,
    ).toBe("list_documents");
    const afterXero = buildConversationState({
      userText: "Tell me Xero sales this month.",
      lastAnswerTopic: "finance",
      currentScope: "BUSINESS_SYSTEM",
      currentBusinessSystem: "xero",
      lastSuccessfulTool: "xero_sales_summary",
    });
    const correction = classifyScope("No, I meant email.", afterXero);
    expect(correction.tool).toBe("outlook_search_mailbox");
    expect(correction.tool).not.toMatch(/^xero_/);
  });

  it("routes newest/latest file questions to list_documents, not search or index stats", () => {
    for (const text of [
      "What's the newest document in OneDrive?",
      "Show me the latest ten files.",
      "What was uploaded today?",
    ]) {
      const decision = classifyScope(text, buildConversationState({ userText: text }));
      expect(decision.tool).toBe("list_documents");
      expect(decision.tool).not.toBe("search_company_knowledge");
      expect(decision.tool).not.toBe("get_document_index_stats");
    }
    expect(classifyScope("Find a document about boilers", buildConversationState({ userText: "Find a document about boilers" })).tool).toBe(
      "search_company_knowledge",
    );
    expect(classifyScope("How many documents can you see?", buildConversationState({ userText: "How many documents can you see?" })).tool).toBe(
      "get_document_index_stats",
    );
  });
});

describe("system meta intelligence", () => {
  it("does not search the current document for a system inventory question", async () => {
    const calls: string[] = [];
    const runtime: IntelligenceRuntime = {
      async executeTool(call): Promise<IntelligenceToolResult> {
        calls.push(call.name);
        return {
          name: call.name,
          ok: true,
          latencyMs: 3,
          data: {
            totalIndexed: 14,
            bySource: [
              { source: "SharePoint", count: 9 },
              { source: "Google Drive", count: 5 },
            ],
            byType: [{ type: "PDF", count: 10 }],
            lastSyncAt: "2026-08-30T10:00:00Z",
          },
        };
      },
    };
    const result = await runIntelligenceTurn({
      text: "How many files are there on the system?",
      state: buildConversationState({
        userText: "How many files are there on the system?",
        currentDocument: { id: "doc_cv", title: "Staff profile" },
      }),
      runtime,
    });
    expect(calls).toEqual(["get_document_index_stats"]);
    expect(result.scope).toBe("SYSTEM_META");
    expect(result.text).toMatch(/14/);
    expect(result.text).not.toMatch(/can't see anything in this document/i);
  });

  it("answers general conversation without tools", async () => {
    const calls: string[] = [];
    const result = await runIntelligenceTurn({
      text: "thanks that's useful",
      state: buildConversationState({ userText: "thanks that's useful" }),
      runtime: {
        async executeTool(call): Promise<IntelligenceToolResult> {
          calls.push(call.name);
          return { name: call.name, ok: true, latencyMs: 1, data: {} };
        },
      },
    });
    expect(calls).toEqual([]);
    expect(result.scope).toBe("GENERAL_CONVERSATION");
    expect(result.toolCalls).toEqual([]);
  });

  it("rephrases the previous answer without rerunning tools", async () => {
    const calls: string[] = [];
    const result = await runIntelligenceTurn({
      text: "Explain your last answer more simply",
      state: buildConversationState({
        userText: "Explain your last answer more simply",
        currentDocument: { id: "doc_van", title: "Vehicle policy" },
        lastAnswerText: "Drivers must return the vehicle when employment ends and record fuel weekly.",
      }),
      runtime: {
        async executeTool(call): Promise<IntelligenceToolResult> {
          calls.push(call.name);
          return { name: call.name, ok: true, latencyMs: 1, data: {} };
        },
      },
    });
    expect(calls).toEqual([]);
    expect(result.scope).toBe("GENERAL_CONVERSATION");
    expect(result.text).toMatch(/vehicle/i);
  });

  it("asks when a quantity has no resolvable scope", async () => {
    const result = await runIntelligenceTurn({
      text: "How many are there?",
      state: buildConversationState({ userText: "How many are there?" }),
      runtime: {
        async executeTool(): Promise<IntelligenceToolResult> {
          return { name: "search_document", ok: true, latencyMs: 1, data: {} };
        },
      },
    });
    expect(result.kind).toBe("clarify");
    expect(result.scope).toBe("AMBIGUOUS");
  });

  it("honours a correction that switches to the whole system", async () => {
    const calls: string[] = [];
    const result = await runIntelligenceTurn({
      text: "I meant the whole system",
      state: buildConversationState({
        userText: "I meant the whole system",
        currentDocument: { id: "doc_cv", title: "Staff profile" },
        userCorrection: true,
      }),
      runtime: {
        async executeTool(call): Promise<IntelligenceToolResult> {
          calls.push(call.name);
          return {
            name: call.name,
            ok: true,
            latencyMs: 2,
            data: { totalIndexed: 8, bySource: [{ source: "SharePoint", count: 8 }], byType: [], lastSyncAt: null },
          };
        },
      },
    });
    expect(calls[0]).toBe("get_document_index_stats");
    expect(result.scope).toBe("SYSTEM_META");
    expect(result.currentDocument).toBeNull();
  });

  it("verbalises only real counts", () => {
    const data = { totalIndexed: 4, bySource: [{ source: "SharePoint", count: 4 }] };
    const text = verbaliseSystemMeta("get_document_index_stats", data);
    expect(text).toMatch(/4/);
    expect(inventedCount(text, data)).toBe(false);
    expect(inventedCount("You have 999 documents", data)).toBe(true);
  });

  it("aggregates tenant-scoped index stats without inventing rows", async () => {
    resetSystemMetaCache();
    const stats = await loadDocumentIndexStats(
      {
        DB: {
          prepare(sql: string) {
            return {
              bind() {
                return {
                  async all() {
                    if (sql.includes("GROUP BY source_type") && sql.includes("microsoft_knowledge_items")) {
                      return { results: [{ source_type: "sharepoint", n: 3 }] };
                    }
                    if (sql.includes("GROUP BY mime_type")) {
                      return { results: [{ mime_type: "application/pdf", n: 3 }] };
                    }
                    return { results: [] };
                  },
                  async first() {
                    if (sql.includes("MAX")) return { last_sync: "2026-08-30T09:00:00Z" };
                    return null;
                  },
                };
              },
            };
          },
        } as never,
      },
      "co_eval",
    );
    expect(stats.totalIndexed).toBe(3);
    expect(stats.bySource[0]).toEqual({ source: "SharePoint", count: 3 });
    expect(stats.byType[0]?.type).toBe("PDF");
  });
});
