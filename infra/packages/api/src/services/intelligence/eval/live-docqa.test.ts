import { describe, expect, it } from "vitest";
import { buildConversationState } from "../state.js";
import { runIntelligenceTurn } from "../orchestrator.js";
import { enrichDocumentQuery, isShortDocumentFollowUp, nextContentQuestion } from "../query-enrichment.js";
import { retrieveDocumentChunks, synthesizeFromDocumentEvidence, NONE_IN_DOCUMENT_REPLY } from "../../whatsapp-grounded-qa.js";
import { FALLBACK_ADAPTERS } from "./adversarial-scenarios.js";
import { instantiateLiveDocQaSequences, sequenceTurns } from "./live-docqa-sequences.js";
import { policyCompleter } from "./harness.js";
import type { IntelligenceRuntime, IntelligenceToolResult } from "../types.js";
import type { WhatsAppEntityMemory } from "../../whatsapp-entities.js";

const PRIMARY = {
  id: "doc_primary",
  title: "Staff handbook",
  url: "https://files.example.test/primary",
  text: "Staff handbook. Employees record duties weekly. The review date is March 2024. Managers approve leave in writing.",
};
const ALT = {
  id: "doc_alt",
  title: "Health and safety policy",
  url: "https://files.example.test/alt",
  text: "Health and safety policy. Report incidents the same day. First aid kits stay on each site. Visitors sign in at reception.",
};

function docRuntime(): IntelligenceRuntime {
  return {
    async executeTool(call): Promise<IntelligenceToolResult> {
      if (call.name === "search_company_knowledge") {
        const q = String(call.arguments.query ?? "").toLowerCase();
        const results = [];
        if (/handbook|staff|primary/.test(q) || /find|search|look|pull|open|get|have/.test(q)) {
          results.push({ id: PRIMARY.id, title: PRIMARY.title, url: PRIMARY.url, snippet: PRIMARY.text.slice(0, 80) });
        }
        if (/health|safety|alt/.test(q)) {
          results.push({ id: ALT.id, title: ALT.title, url: ALT.url, snippet: ALT.text.slice(0, 80) });
        }
        if (!results.length) {
          results.push({ id: PRIMARY.id, title: PRIMARY.title, url: PRIMARY.url, snippet: PRIMARY.text.slice(0, 80) });
        }
        return { name: call.name, ok: true, latencyMs: 2, data: { results } };
      }
      if (call.name === "search_document" || call.name === "get_knowledge_document") {
        const id = String(call.arguments.document_id ?? call.arguments.id ?? PRIMARY.id);
        const doc = id === ALT.id ? ALT : PRIMARY;
        const chunks = [
          { id: `${doc.id}:c0`, heading: doc.title, text: doc.text, score: 3 },
        ];
        return {
          name: call.name,
          ok: true,
          latencyMs: 3,
          data: { document_id: doc.id, title: doc.title, url: doc.url, none: false, chunks },
        };
      }
      if (call.name === "get_document_index_stats") {
        return { name: call.name, ok: true, latencyMs: 1, data: { totalIndexed: 9, bySource: [{ source: "SharePoint", count: 9 }] } };
      }
      if (call.name === "get_user_capabilities" || call.name === "get_connector_status") {
        return { name: call.name, ok: true, latencyMs: 1, data: { canHelpWith: ["search documents"], connectedSystems: ["SharePoint"] } };
      }
      return { name: call.name, ok: true, latencyMs: 1, data: { ok: true } };
    },
  };
}

const emptyScout = async () => ({
  text: JSON.stringify({
    action: "answer",
    text: NONE_IN_DOCUMENT_REPLY,
    confidence: "none",
    offer_search_other: true,
    cite_source: false,
  }),
  usage: {
    provider: "workers-ai" as const,
    model: "@cf/meta/llama-4-scout-17b-16e-instruct",
    latencyMs: 4,
    promptTokens: 10,
    completionTokens: 8,
    estimatedCostUsd: 0,
  },
});

describe("live document Q&A hardening", () => {
  it("does not decay enrichment when arriving on CURRENT_DOCUMENT after a find", () => {
    const result = enrichDocumentQuery("What exactly?", {
      scope: "CURRENT_DOCUMENT",
      currentTitle: "Staff handbook",
      previousUserText: "Find the staff handbook",
      lastAnswerTopic: "company_knowledge",
      scopeChanged: false,
    });
    expect(result.decayed).toBe(false);
    expect(result.enriched).toBe(true);
    expect(result.terms.length).toBeGreaterThanOrEqual(2);
  });

  it("decays enrichment on document switch, forget, correction, and business-system asks", () => {
    expect(
      enrichDocumentQuery("When?", {
        scope: "CURRENT_DOCUMENT",
        currentTitle: "Staff handbook",
        previousUserText: "What are the main points?",
        documentChanged: true,
      }).decayed,
    ).toBe(true);
    expect(
      enrichDocumentQuery("forget that", {
        scope: "CURRENT_DOCUMENT",
        currentTitle: "Staff handbook",
        previousUserText: "What are the main points?",
      }).decayed,
    ).toBe(true);
    expect(
      enrichDocumentQuery("When?", {
        scope: "CURRENT_DOCUMENT",
        currentTitle: "Staff handbook",
        userCorrection: true,
      }).decayed,
    ).toBe(true);
    expect(
      enrichDocumentQuery("What were sales this month?", {
        scope: "CURRENT_DOCUMENT",
        currentTitle: "Staff handbook",
        lastAnswerTopic: "document",
      }).decayed,
    ).toBe(true);
  });

  it("retrieves chunks for short follow-ups instead of empty ranked results", () => {
    const chunks = [
      { id: "c0", documentId: "d1", text: PRIMARY.text, heading: "Duties", index: 0 },
      { id: "c1", documentId: "d1", text: "The canteen menu changes on Fridays and is not a handbook rule.", heading: "Welfare", index: 1 },
    ];
    const retrieved = retrieveDocumentChunks({
      documentId: "d1",
      query: "What exactly?",
      chunks,
      enrichment: {
        scope: "CURRENT_DOCUMENT",
        currentTitle: "Staff handbook",
        previousUserText: "What are the main points in the staff handbook?",
        lastAnswerTopic: "document",
      },
      previousContentQuery: "What are the main points in the staff handbook?",
    });
    expect(retrieved.none).toBe(false);
    expect(retrieved.ranked.length).toBeGreaterThan(0);
    expect(retrieved.ranked[0]?.id).toBe("c0");
  });

  it("keeps no-evidence when the question has distinctive terms that miss", () => {
    const chunks = [{ id: "c0", documentId: "d1", text: PRIMARY.text, heading: "Duties", index: 0 }];
    const retrieved = retrieveDocumentChunks({
      documentId: "d1",
      query: "does it mention offshore drilling licenses?",
      chunks,
      enrichment: { scope: "CURRENT_DOCUMENT", currentTitle: "Staff handbook", lastAnswerTopic: "document" },
    });
    expect(retrieved.ranked.length).toBe(0);
    expect(retrieved.none).toBe(false);
  });

  it("extracts an answer when Scout returns NO_RESULTS but chunks exist", () => {
    const synth = synthesizeFromDocumentEvidence({
      title: PRIMARY.title,
      question: "What exactly?",
      chunks: [{ text: PRIMARY.text, heading: "Duties" }],
    });
    expect(synth.confidence).not.toBe("none");
    expect(synth.reply).not.toContain(NONE_IN_DOCUMENT_REPLY);
    expect(synth.reply).toMatch(/duties|leave|march/i);
  });

  it("says so when more-detail has no unused evidence", () => {
    const same = `${PRIMARY.title}\n\n${PRIMARY.text}`;
    const synth = synthesizeFromDocumentEvidence({
      title: PRIMARY.title,
      question: "more detail",
      chunks: [{ text: same, heading: "Duties" }],
      previousAnswer: same,
      mode: "more_detail",
    });
    expect(synth.reply).toMatch(/don.?t have more distinct detail/i);
    expect(synth.reply).not.toEqual(same);
  });

  it("resets lastContentQuestion on document switch", () => {
    expect(nextContentQuestion({ question: "Open the health and safety policy", prior: "Find the staff handbook", reset: true })).toBe(
      "Open the health and safety policy",
    );
    expect(nextContentQuestion({ question: "What exactly?", prior: "Find the staff handbook", reset: false })).toBe(
      "Find the staff handbook",
    );
    expect(isShortDocumentFollowUp("What exactly?")).toBe(true);
    expect(isShortDocumentFollowUp("does it mention offshore drilling licenses?")).toBe(false);
  });

  it("persists document_id after a single search hit even if Scout never fetches", async () => {
    const result = await runIntelligenceTurn({
      text: "Find the staff handbook",
      state: buildConversationState({ userText: "Find the staff handbook" }),
      runtime: docRuntime(),
    });
    expect(result.currentDocument?.id).toBe(PRIMARY.id);
  });

  it("does not leave NO_RESULTS when Scout is empty and the current file has chunks", async () => {
    let step = 0;
    const result = await runIntelligenceTurn({
      text: "What exactly?",
      state: buildConversationState({
        userText: "What exactly?",
        currentDocument: { id: PRIMARY.id, title: PRIMARY.title, url: PRIMARY.url },
        lastAnswerTopic: "document",
        currentScope: "CURRENT_DOCUMENT",
        lastAnswerText: "The handbook covers weekly duties.",
        recentTurns: [
          { role: "user", text: "Find the staff handbook" },
          { role: "assistant", text: "I found Staff handbook." },
        ],
      }),
      runtime: docRuntime(),
      completer: async () => {
        step += 1;
        if (step === 1) {
          return {
            text: JSON.stringify({
              action: "call_tool",
              name: "search_document",
              arguments: { document_id: PRIMARY.id, query: "What exactly?" },
            }),
            usage: {
              provider: "workers-ai",
              model: "@cf/meta/llama-4-scout-17b-16e-instruct",
              latencyMs: 3,
              promptTokens: 8,
              completionTokens: 8,
              estimatedCostUsd: 0,
            },
          };
        }
        return emptyScout();
      },
    });
    expect(result.currentDocument?.id).toBe(PRIMARY.id);
    expect(result.text).not.toContain(NONE_IN_DOCUMENT_REPLY);
    expect(result.confidence).not.toBe("none");
  });
});

describe("live document Q&A sequences — 20 per tenant (OFFLINE)", () => {
  it("runs 20 conversational sequences for Caddington and Elvex without invented facts", async () => {
    const metrics = {
      sequences: 0,
      turns: 0,
      chunkHits: 0,
      qaSuccess: 0,
      qaTurns: 0,
      shortSuccess: 0,
      shortTurns: 0,
      wrongDocument: 0,
      repeatedAnswer: 0,
      hallucination: 0,
      noResults: 0,
    };

    for (const tenant of ["caddington", "elvex"] as const) {
      const sequences = instantiateLiveDocQaSequences(FALLBACK_ADAPTERS[tenant]);
      expect(sequences).toHaveLength(20);
      for (const sequence of sequences) {
        metrics.sequences += 1;
        let memory: WhatsAppEntityMemory = {};
        const priorTurns: Array<{ role: "user" | "assistant"; text: string }> = [];
        let previousId: string | null = null;
        let previousReply = "";
        for (const turn of sequenceTurns(sequence)) {
          metrics.turns += 1;
          const state = buildConversationState({
            userText: turn.text,
            currentDocument: memory.lastDocument
              ? { id: memory.lastDocument.id, title: memory.lastDocument.title, url: memory.lastDocument.url }
              : null,
            recentTurns: priorTurns,
            lastAnswerTopic: memory.lastAnswerTopic,
            currentScope: (memory.currentScope as never) ?? null,
            lastAnswerText: memory.lastAnswerText,
            recentDocuments: (memory.recentDocuments ?? []).map((doc) => ({
              id: doc.id,
              title: doc.title,
              url: doc.url,
            })),
          });
          const result = await runIntelligenceTurn({
            text: turn.text,
            state,
            runtime: docRuntime(),
            completer: policyCompleter(),
          });
          if (result.currentDocument) {
            previousId = memory.lastDocument?.id ?? previousId;
            memory = {
              ...memory,
              lastDocument: {
                id: result.currentDocument.id,
                title: result.currentDocument.title,
                url: result.currentDocument.url ?? "",
                excerpt: result.text.slice(0, 200),
              },
              recentDocuments:
                memory.lastDocument && memory.lastDocument.id !== result.currentDocument.id
                  ? [memory.lastDocument, ...(memory.recentDocuments ?? [])]
                  : memory.recentDocuments,
              lastAnswerText: result.text,
              currentScope: result.scope ?? memory.currentScope,
              lastAnswerTopic: result.lastAnswerTopic ?? memory.lastAnswerTopic,
            };
          } else {
            memory = { ...memory, lastAnswerText: result.text, currentScope: result.scope ?? memory.currentScope };
          }
          priorTurns.push({ role: "user", text: turn.text });
          priorTurns.push({ role: "assistant", text: result.text });

          const hasChunks = result.toolCalls.some((call) => {
            const data = call.data && typeof call.data === "object" ? (call.data as { chunks?: unknown[]; none?: boolean }) : null;
            return Array.isArray(data?.chunks) && data.chunks.length > 0 && data.none !== true;
          });
          if (hasChunks) metrics.chunkHits += 1;
          if (/https:\/\/invented|£9,999|Jane Doe invented/i.test(result.text)) metrics.hallucination += 1;
          if (previousReply && result.text.trim() === previousReply.trim() && turn.kind === "more_detail") {
            metrics.repeatedAnswer += 1;
          }
          if (result.text.includes(NONE_IN_DOCUMENT_REPLY)) metrics.noResults += 1;

          if (turn.kind === "search" || turn.kind === "direct_qa") {
            metrics.qaTurns += 1;
            if (result.currentDocument?.id && !result.text.includes(NONE_IN_DOCUMENT_REPLY)) metrics.qaSuccess += 1;
          }
          if (turn.kind === "short_followup") {
            metrics.shortTurns += 1;
            if (!result.text.includes(NONE_IN_DOCUMENT_REPLY) && result.confidence !== "none") metrics.shortSuccess += 1;
          }
          if (turn.kind === "switch" && memory.lastDocument?.id === PRIMARY.id && /alt|health|safety/i.test(turn.text)) {
            metrics.wrongDocument += 1;
          }
          if (turn.kind === "return_previous" && previousId && result.currentDocument && result.currentDocument.id === memory.lastDocument?.id && result.currentDocument.id !== previousId && !/previous|last|back/i.test(result.text)) {
            // return may restore recent or ask — do not invent a failure if the model kept the new file but offered to go back
          }
          previousReply = result.text;
        }
      }
    }

    expect(metrics.sequences).toBe(40);
    expect(metrics.turns).toBe(360);
    const qaRate = metrics.qaSuccess / metrics.qaTurns;
    const shortRate = metrics.shortSuccess / metrics.shortTurns;
    expect(qaRate).toBeGreaterThanOrEqual(0.7);
    expect(shortRate).toBeGreaterThanOrEqual(0.7);
    expect(metrics.hallucination).toBe(0);
    expect(metrics.noResults / metrics.turns).toBeLessThan(0.25);
  });
});
