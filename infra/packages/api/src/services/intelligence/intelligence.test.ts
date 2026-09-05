import { describe, expect, it } from "vitest";
import { HARD_TIMEOUT_MS, PROGRESS_AFTER_MS, PROGRESS_MIN_INTERVAL_MS } from "../whatsapp-latency.js";
import { NONE_IN_DOCUMENT_REPLY, SEARCH_OTHER_DOCS_HINT } from "../whatsapp-grounded-qa.js";
import { planFromIntelligence } from "../whatsapp-intelligence.js";
import { describeToolCatalogue, INTELLIGENCE_TOOL_NAMES } from "./catalogue.js";
import { isFastPathTurn, matchFastPath } from "./fast-path.js";
import { parseIntelligenceDecision, runIntelligenceTurn } from "./orchestrator.js";
import { inspectIntelligenceProvider } from "./provider.js";
import { buildConversationState } from "./state.js";
import type { IntelligenceRuntime, IntelligenceToolResult } from "./types.js";
import type { IntelligenceCompleter } from "./provider.js";

const UNSEEN_QUESTIONS = [
  "what's our policy on returning damaged stock?",
  "did we ever sponsor a local cricket team?",
  "can you compare last year's skip hire quotes with this year's?",
  "find my CV from 2015 and tell me whether I did anything in marketing",
  "what exactly did I do?",
  "where did you get that from?",
  "does it say anything about company vehicles?",
];

function intelligenceSurface(): string {
  return [
    describeToolCatalogue(),
    matchFastPath("hi") ?? "",
    matchFastPath("thanks") ?? "",
    matchFastPath("help") ?? "",
    [...INTELLIGENCE_TOOL_NAMES].join(","),
  ].join("\n");
}

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
        return { name: call.name, ok: true, latencyMs: 4, data };
      },
    },
  };
}

/** Protocol-only stub: any non-fast-path question searches, then fetches, then answers. No business phrases. */
function genericBusinessCompleter(): IntelligenceCompleter {
  let sawSearch = false;
  let sawFetch = false;
  return async ({ user }) => {
    const userLine = user.match(/User: (.*)$/m)?.[1] ?? "";
    if (!sawSearch) {
      sawSearch = true;
      return {
        text: JSON.stringify({
          action: "call_tool",
          name: "search_company_knowledge",
          arguments: { query: userLine },
        }),
        usage: {
          provider: "workers-ai",
          model: "@cf/meta/llama-3.1-8b-instruct",
          latencyMs: 12,
          promptTokens: 80,
          completionTokens: 20,
          estimatedCostUsd: 0.0001,
        },
      };
    }
    if (!sawFetch) {
      sawFetch = true;
      return {
        text: JSON.stringify({
          action: "call_tool",
          name: "get_knowledge_document",
          arguments: { document_id: "doc_found" },
        }),
        usage: {
          provider: "workers-ai",
          model: "@cf/meta/llama-3.1-8b-instruct",
          latencyMs: 11,
          promptTokens: 90,
          completionTokens: 18,
          estimatedCostUsd: 0.0001,
        },
      };
    }
    return {
      text: JSON.stringify({
        action: "answer",
        text: "From the retrieved document: it covers the requested topic.",
        confidence: "partial",
        offer_search_other: false,
        cite_source: true,
      }),
      usage: {
        provider: "workers-ai",
        model: "@cf/meta/llama-3.1-8b-instruct",
        latencyMs: 14,
        promptTokens: 100,
        completionTokens: 30,
        estimatedCostUsd: 0.00012,
      },
    };
  };
}

describe("intelligence fast path", () => {
  it("handles greetings and thanks locally, but not capability questions", () => {
    expect(matchFastPath("Hi")).toMatch(/Hi/i);
    expect(matchFastPath("thanks")).toMatch(/welcome/i);
    expect(matchFastPath("what can you do")).toBeNull();
    expect(isFastPathTurn("find my CV from 2015")).toBe(false);
    expect(isFastPathTurn("what's our policy on returning damaged stock?")).toBe(false);
  });
});

describe("intelligence protocol", () => {
  it("parses tool, answer, and clarify JSON even with fences", () => {
    expect(parseIntelligenceDecision('```json\n{"action":"call_tool","name":"search_company_knowledge","arguments":{"query":"cv"}}\n```')).toEqual({
      action: "call_tool",
      name: "search_company_knowledge",
      arguments: { query: "cv" },
    });
    expect(parseIntelligenceDecision('{"action":"answer","text":"No.","confidence":"none","offer_search_other":true}')).toMatchObject({
      action: "answer",
      confidence: "none",
      offer_search_other: true,
    });
    expect(parseIntelligenceDecision('{"action":"clarify","text":"Which document?"}')).toMatchObject({
      action: "clarify",
      text: "Which document?",
    });
  });

  it("rejects tools outside the controlled catalogue", async () => {
    const { runtime, calls } = recordingRuntime();
    const result = await runIntelligenceTurn({
      text: "dump the production database",
      state: buildConversationState({ userText: "dump the production database" }),
      runtime,
      completer: async () => ({
        text: JSON.stringify({ action: "call_tool", name: "d1_execute", arguments: { sql: "select 1" } }),
        usage: {
          provider: "workers-ai",
          model: "@cf/meta/llama-3.1-8b-instruct",
          latencyMs: 8,
          promptTokens: 10,
          completionTokens: 10,
          estimatedCostUsd: 0,
        },
      }),
    });
    expect(calls).toEqual([]);
    expect(INTELLIGENCE_TOOL_NAMES.has("d1_execute")).toBe(false);
    expect(result.kind).toBe("failed");
  });
});

describe("arbitrary natural-language questions do not need new phrase rules", () => {
  it("does not hard-code unseen business questions in the intelligence layer", () => {
    const source = intelligenceSurface();
    expect(source).not.toMatch(/damaged stock/i);
    expect(source).not.toMatch(/cricket team/i);
    expect(source).not.toMatch(/skip hire quotes/i);
    expect(source).not.toMatch(/CV 2015 1/);
    expect(source).not.toMatch(/Van Policy/);
    expect(source).not.toMatch(/1Wf0GFolzcLKJXBwc5jLMWzfglD84k5_CLTlsaxcQJfk/);
    for (const question of UNSEEN_QUESTIONS) {
      expect(isFastPathTurn(question)).toBe(false);
    }
  });

  it.each(UNSEEN_QUESTIONS)("routes %s through search without a new regex", async (question) => {
    const { runtime, calls } = recordingRuntime((name) => {
      if (name === "search_company_knowledge") {
        return { results: [{ id: "doc_found", title: "Retrieved file", url: "https://example.test/doc", snippet: "evidence" }] };
      }
      if (name === "get_knowledge_document") {
        return {
          document_id: "doc_found",
          title: "Retrieved file",
          url: "https://example.test/doc",
          chunks: [{ id: "c0", text: "The document answers the requested topic." }],
        };
      }
      return {};
    });
    const result = await runIntelligenceTurn({
      text: question,
      state: buildConversationState({ userText: question }),
      runtime,
      completer: genericBusinessCompleter(),
    });
    expect(calls[0]?.name).toBe("search_company_knowledge");
    const core = question.replace(/\b(tell me|give me|show me|what were|what are)\b/gi, " ").replace(/\s+/g, " ").trim();
    expect(String(calls[0]?.arguments.query).toLowerCase()).toContain(core.slice(0, 18).toLowerCase());
    expect(calls.some((call) => call.name === "get_knowledge_document")).toBe(true);
    expect(result.kind).toBe("answer");
    expect(result.currentDocument?.id).toBe("doc_found");
    expect(result.currentDocument?.url).toBe("https://example.test/doc");
  });
});

describe("document-grounded multi-turn behaviour", () => {
  it("inspects the current document first on a follow-up", async () => {
    const { runtime, calls } = recordingRuntime((name, args) => {
      if (name === "search_document") {
        return {
          document_id: args.document_id,
          title: "Staff profile",
          url: "https://docs.google.com/document/d/abc/edit",
          chunks: [{ id: "c1", text: "Field sales executive covering the south east." }],
        };
      }
      return {};
    });
    let step = 0;
    const result = await runIntelligenceTurn({
      text: "what exactly did I do?",
      state: buildConversationState({
        userText: "what exactly did I do?",
        currentDocument: {
          id: "doc_cv",
          title: "Staff profile",
          url: "https://docs.google.com/document/d/abc/edit",
        },
        recentTurns: [
          { role: "user", text: "find my 2015 CV and tell me if I did marketing" },
          { role: "assistant", text: "The CV includes field sales work." },
        ],
      }),
      runtime,
      completer: async () => {
        step += 1;
        if (step === 1) {
          return {
            text: JSON.stringify({
              action: "call_tool",
              name: "search_document",
              arguments: { document_id: "doc_cv", query: "what exactly did I do?" },
            }),
            usage: {
              provider: "workers-ai",
              model: "@cf/meta/llama-3.1-8b-instruct",
              latencyMs: 9,
              promptTokens: 40,
              completionTokens: 12,
              estimatedCostUsd: 0,
            },
          };
        }
        return {
          text: JSON.stringify({
            action: "answer",
            text: "You were a field sales executive covering the south east.",
            confidence: "strong",
            offer_search_other: false,
            cite_source: false,
          }),
          usage: {
            provider: "workers-ai",
            model: "@cf/meta/llama-3.1-8b-instruct",
            latencyMs: 10,
            promptTokens: 50,
            completionTokens: 20,
            estimatedCostUsd: 0,
          },
        };
      },
    });
    expect(calls[0]?.name).toBe("search_document");
    expect(calls[0]?.arguments.document_id).toBe("doc_cv");
    expect(String(calls[0]?.arguments.query ?? "")).toContain("what exactly did I do?");
    expect(calls.some((call) => call.name === "search_company_knowledge")).toBe(false);
    expect(result.text).toMatch(/field sales/i);
    expect(result.currentDocument?.id).toBe("doc_cv");
  });

  it("stays on the current document when evidence is absent and offers broader search", async () => {
    const { runtime, calls } = recordingRuntime(() => ({
      document_id: "doc_cv",
      title: "Staff profile",
      none: true,
      chunks: [],
    }));
    let step = 0;
    const result = await runIntelligenceTurn({
      text: "does it say anything about company vehicles?",
      state: buildConversationState({
        userText: "does it say anything about company vehicles?",
        currentDocument: { id: "doc_cv", title: "Staff profile", url: "https://example.test/cv" },
      }),
      runtime,
      completer: async () => {
        step += 1;
        if (step === 1) {
          return {
            text: JSON.stringify({
              action: "call_tool",
              name: "search_document",
              arguments: { document_id: "doc_cv", query: "company vehicles" },
            }),
            usage: {
              provider: "workers-ai",
              model: "@cf/meta/llama-3.1-8b-instruct",
              latencyMs: 8,
              promptTokens: 20,
              completionTokens: 10,
              estimatedCostUsd: 0,
            },
          };
        }
        return {
          text: JSON.stringify({
            action: "answer",
            text: `${NONE_IN_DOCUMENT_REPLY} ${SEARCH_OTHER_DOCS_HINT}`,
            confidence: "none",
            offer_search_other: true,
            cite_source: false,
          }),
          usage: {
            provider: "workers-ai",
            model: "@cf/meta/llama-3.1-8b-instruct",
            latencyMs: 8,
            promptTokens: 20,
            completionTokens: 10,
            estimatedCostUsd: 0,
          },
        };
      },
    });
    expect(calls[0]?.name).toBe("search_document");
    expect(result.confidence).toBe("none");
    expect(result.offerSearchOther).toBe(true);
    expect(result.currentDocument?.id).toBe("doc_cv");
    expect(result.text).toContain(NONE_IN_DOCUMENT_REPLY);
  });

  it("cites a retrieved source URL when asked where the answer came from", async () => {
    const { runtime } = recordingRuntime(() => ({
      document_id: "doc_cv",
      title: "Staff profile",
      url: "https://docs.google.com/document/d/abc/edit",
      chunks: [{ id: "c0", text: "Field sales." }],
    }));
    let step = 0;
    const result = await runIntelligenceTurn({
      text: "where did you get that from?",
      state: buildConversationState({
        userText: "where did you get that from?",
        currentDocument: {
          id: "doc_cv",
          title: "Staff profile",
          url: "https://docs.google.com/document/d/abc/edit",
        },
      }),
      runtime,
      completer: async () => {
        step += 1;
        if (step === 1) {
          return {
            text: JSON.stringify({
              action: "call_tool",
              name: "get_knowledge_document",
              arguments: { document_id: "doc_cv" },
            }),
            usage: {
              provider: "workers-ai",
              model: "@cf/meta/llama-3.1-8b-instruct",
              latencyMs: 7,
              promptTokens: 20,
              completionTokens: 8,
              estimatedCostUsd: 0,
            },
          };
        }
        return {
          text: JSON.stringify({
            action: "answer",
            text: "From this Google Doc: https://docs.google.com/document/d/abc/edit",
            confidence: "strong",
            offer_search_other: false,
            cite_source: true,
          }),
          usage: {
            provider: "workers-ai",
            model: "@cf/meta/llama-3.1-8b-instruct",
            latencyMs: 7,
            promptTokens: 20,
            completionTokens: 20,
            estimatedCostUsd: 0,
          },
        };
      },
    });
    expect(result.text).toContain("https://docs.google.com/document/d/abc/edit");
    expect(result.citeSource).toBe(true);
  });

  it("replans after bare negative feedback using the prior user question", async () => {
    const { runtime, calls } = recordingRuntime(() => ({
      results: [{ id: "doc_coal", title: "Coal Search", url: "https://drive.google.com/file/d/abc/view" }],
    }));
    const result = await runIntelligenceTurn({
      text: "that's not what I asked",
      state: buildConversationState({
        userText: "that's not what I asked",
        currentDocument: { id: "doc_cv", title: "Staff profile" },
        userCorrection: true,
        recentTurns: [
          { role: "user", text: "find Coal Search" },
          { role: "assistant", text: "I found a marketing review." },
        ],
      }),
      runtime,
    });
    expect(calls[0]?.name).toBe("search_company_knowledge");
    expect(String(calls[0]?.arguments.query ?? "")).toMatch(/Coal Search/i);
    expect(result.text).toMatch(/Coal Search/i);
    expect(result.offerSearchOther).toBe(true);
  });
});

describe("model-empty retrieval bootstrap", () => {
  it("still searches with the raw user text when the model returns nothing", async () => {
    const unseen = "what's our policy on returning damaged stock?";
    const { runtime, calls } = recordingRuntime(() => ({
      results: [{ id: "doc_policy", title: "Returns policy", url: "https://example.test/returns" }],
    }));
    const result = await runIntelligenceTurn({
      text: unseen,
      state: buildConversationState({ userText: unseen }),
      runtime,
      completer: async () => ({
        text: "",
        usage: {
          provider: "workers-ai",
          model: "@cf/meta/llama-3.1-8b-instruct",
          latencyMs: 5,
          promptTokens: 10,
          completionTokens: 0,
          estimatedCostUsd: 0,
        },
      }),
    });
    expect(calls[0]).toEqual({
      name: "search_company_knowledge",
      arguments: { query: unseen },
    });
    expect(result.toolCalls.length).toBeGreaterThan(0);
  });
});

describe("whatsapp plan mapping and provider boundary", () => {
  it("maps document-grounded intelligence to entity-bound WhatsApp buttons", () => {
    const plan = planFromIntelligence(
      {
        kind: "answer",
        text: "Field sales work.",
        confidence: "strong",
        offerSearchOther: false,
        toolCalls: [
          {
            name: "search_document",
            ok: true,
            latencyMs: 20,
            data: { document_id: "doc_cv", title: "Staff profile" },
          },
        ],
        currentDocument: { id: "doc_cv", title: "Staff profile", url: "https://example.test/cv" },
        evidenceDocumentIds: ["doc_cv"],
        clarification: false,
        citeSource: false,
        modelRounds: [],
        totalModelMs: 20,
        totalToolMs: 20,
        provider: "workers-ai",
        model: "@cf/meta/llama-3.1-8b-instruct",
        estimatedCostUsd: 0.0002,
      },
      "what exactly did I do?",
      "more_on_this",
    );
    expect(plan.action).toBe("memory_fact");
    expect(plan.useMemory).toBe(true);
    expect(plan.fact).toBe("detail");
  });

  it("does not invent credentials and reports none when unconfigured", () => {
    const inspected = inspectIntelligenceProvider({});
    expect(inspected.provider).toBe("none");
    expect(inspected.configured).toBe(false);
  });

  it("keeps the V4.7 60s progress cadence", () => {
    expect(PROGRESS_AFTER_MS).toBe(60_000);
    expect(PROGRESS_MIN_INTERVAL_MS).toBe(60_000);
    expect(HARD_TIMEOUT_MS).toBe(120_000);
  });
});

describe("V1.1 structured recovery and correction", () => {
  it("recovers a tool call from malformed JSON and never executes unknown tools", async () => {
    const { runtime, calls } = recordingRuntime();
    const result = await runIntelligenceTurn({
      text: "what exactly did I do?",
      state: buildConversationState({
        userText: "what exactly did I do?",
        currentDocument: { id: "doc_cv", title: "Staff profile" },
      }),
      runtime,
      completer: async () => ({
        text: 'I will call search_document with query="what exactly did I do?" and document_id=doc_cv',
        usage: {
          provider: "workers-ai",
          model: "@cf/meta/llama-4-scout-17b-16e-instruct",
          latencyMs: 9,
          promptTokens: 20,
          completionTokens: 20,
          estimatedCostUsd: 0,
        },
      }),
    });
    expect(calls[0]?.name).toBe("search_document");
    expect(result.repaired || result.qualityFlags?.includes("malformed_model_response")).toBeTruthy();
  });

  it("replans after a user correction that names a new document", async () => {
    const { runtime, calls } = recordingRuntime();
    const result = await runIntelligenceTurn({
      text: "Wrong file, I meant the vehicle policy",
      state: buildConversationState({
        userText: "Wrong file, I meant the vehicle policy",
        currentDocument: { id: "doc_cv", title: "Staff profile" },
        userCorrection: true,
        recentTurns: [{ role: "assistant", text: "I found a marketing review." }],
      }),
      runtime,
      completer: async () => ({
        text: JSON.stringify({
          action: "call_tool",
          name: "search_company_knowledge",
          arguments: { query: "vehicle policy" },
        }),
        usage: {
          provider: "workers-ai",
          model: "@cf/meta/llama-4-scout-17b-16e-instruct",
          latencyMs: 8,
          promptTokens: 20,
          completionTokens: 12,
          estimatedCostUsd: 0,
        },
      }),
    });
    expect(calls[0]?.name).toBe("search_company_knowledge");
    expect(result.qualityFlags).toContain("user_correction");
  });

  it("returns a validated source URL locally when it is already on the current entity", async () => {
    const { runtime, calls } = recordingRuntime();
    const result = await runIntelligenceTurn({
      text: "Open the source",
      state: buildConversationState({
        userText: "Open the source",
        currentDocument: { id: "doc_cv", title: "Staff profile", url: "https://docs.example.test/profile" },
      }),
      runtime,
    });
    expect(calls).toEqual([]);
    expect(result.kind).toBe("fast_path");
    expect(result.text).toBe("https://docs.example.test/profile");
    expect(result.route).toBe("FAST_LOCAL");
  });
});

describe("catalogue newest/latest follow-up", () => {
  it("adopts the newest listed file and answers metadata follow-ups without a new search", async () => {
    const { runtime, calls } = recordingRuntime((name) => {
      if (name === "list_documents") {
        return {
          status: "ok",
          source: "onedrive",
          dateField: "modified_at",
          documents: [
            {
              id: "doc_jobs",
              title: "Elvex Jobs.xlsx",
              source: "onedrive",
              modifiedAt: "2026-09-01T15:23:09Z",
              modifiedBy: null,
              url: "https://elvex-my.sharepoint.com/personal/a/Elvex%20Jobs.xlsx",
            },
          ],
        };
      }
      return {};
    });
    const listed = await runIntelligenceTurn({
      text: "Find the newest OneDrive document.",
      state: buildConversationState({ userText: "Find the newest OneDrive document." }),
      runtime,
    });
    expect(calls[0]?.name).toBe("list_documents");
    expect(listed.currentDocument?.id).toBe("doc_jobs");
    expect(listed.text).toMatch(/Elvex Jobs\.xlsx/);

    const who = await runIntelligenceTurn({
      text: "Who modified it?",
      state: buildConversationState({
        userText: "Who modified it?",
        currentDocument: listed.currentDocument,
        lastAnswerTopic: "document_catalogue",
        currentScope: "COMPANY_KNOWLEDGE",
      }),
      runtime,
    });
    expect(who.text).toMatch(/does not include who last modified/i);
    expect(who.toolCalls).toEqual([]);
    expect(who.scope).toBe("CURRENT_DOCUMENT");
  });
});

describe("V1.1 evaluation harness", () => {
  it("covers at least 100 natural-language cases and scores the policy completer", async () => {
    const { evaluationCases } = await import("./eval/cases.js");
    const { runEvaluationSuite, policyCompleter, v1FragileCompleter } = await import("./eval/harness.js");
    const cases = evaluationCases();
    expect(cases.length).toBeGreaterThanOrEqual(100);
    expect(cases.filter((row) => row.messy).length).toBeGreaterThanOrEqual(20);
    const surface = intelligenceSurface();
    expect(surface).not.toMatch(/Van Policy/);
    expect(surface).not.toMatch(/CV 2015/);
    expect(surface).not.toMatch(/1Wf0GFolzcLKJXBwc5jLMWzfglD84k5_CLTlsaxcQJfk/);
    const policy = await runEvaluationSuite(policyCompleter());
    const fragile = await runEvaluationSuite(v1FragileCompleter());
    expect(policy.scores.infraScore).toBeGreaterThan(fragile.scores.infraScore);
    expect(policy.scores.correctTool).toBeGreaterThan(70);
    expect(policy.scores.grounded).toBeGreaterThan(80);
  });
});
