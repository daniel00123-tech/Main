import { describe, expect, it } from "vitest";
import { classifyScope } from "./intelligence/scope.js";
import { buildConversationState } from "./intelligence/state.js";
import { runIntelligenceTurn } from "./intelligence/orchestrator.js";
import type { IntelligenceRuntime, IntelligenceToolResult } from "./intelligence/types.js";
import { isGenericRetryCopy } from "./intelligence/verbalise-business.js";
import { titleFromUserText } from "./portal-chat-types.js";

function runtime(handler: (name: string, args: Record<string, unknown>) => IntelligenceToolResult): IntelligenceRuntime {
  return {
    async executeTool(call) {
      return handler(call.name, call.arguments);
    },
  };
}

const TURNS: Array<{
  id: string;
  text: string;
  lastTopic?: string | null;
  expect?: Partial<{ scope: string; tool: string | null; clarify: boolean }>;
}> = [
  { id: "1", text: "what are our xero sales this month", expect: { scope: "BUSINESS_SYSTEM", tool: "xero_sales_summary" } },
  { id: "2", text: "whats our xero sales this mnth", expect: { scope: "BUSINESS_SYSTEM", tool: "xero_sales_summary" } },
  { id: "3", text: "what is the newest email in the inbox", expect: { scope: "BUSINESS_SYSTEM", tool: "outlook_list_messages" } },
  { id: "4", text: "yeah thats right the info inbox what is the latest email", lastTopic: "email", expect: { tool: "outlook_list_messages" } },
  { id: "5", text: "what about the finance inbox", lastTopic: "email", expect: { tool: "outlook_list_messages" } },
  { id: "6", text: "what about in my inbox?", lastTopic: "email", expect: { clarify: true } },
  { id: "7", text: "what does it say?", lastTopic: "email", expect: { scope: "BUSINESS_SYSTEM" } },
  { id: "8", text: "who sent it", lastTopic: "email" },
  { id: "9", text: "Search company files for PO process", expect: { scope: "COMPANY_KNOWLEDGE" } },
  { id: "10", text: "what is the newest OneDrive document", expect: { tool: "list_documents" } },
  { id: "11", text: "what is 2+2", expect: { scope: "GENERAL_CONVERSATION" } },
  { id: "12", text: "whats the weather in London now", expect: { tool: "web_search" } },
  { id: "13", text: "ok great, and what’s the newest email in the inbox?", expect: { tool: "outlook_list_messages" } },
  { id: "14", text: "no I meant email", lastTopic: "finance", expect: { tool: "outlook_list_messages" } },
  { id: "15", text: "actually check Xero", lastTopic: "email", expect: { tool: "xero_sales_summary" } },
  { id: "16", text: "and what about last month", lastTopic: "finance", expect: { tool: "xero_sales_summary" } },
  { id: "17", text: "Can you send emails?", expect: { scope: "CONTROLLED_ACTION" } },
  { id: "18", text: "create a Xero invoice", expect: { scope: "CONTROLLED_ACTION" } },
  { id: "19", text: "hi", expect: { scope: "GENERAL_CONVERSATION" } },
  { id: "20", text: "thanks", expect: { scope: "GENERAL_CONVERSATION" } },
  { id: "21", text: "help me write a polite reply", expect: { scope: "GENERAL_CONVERSATION" } },
  { id: "22", text: "Who won the game last night?", expect: { tool: "web_search" } },
  { id: "23", text: "Find the website for Open-Meteo", expect: { tool: "web_search" } },
  { id: "24", text: "what is outstanding in Xero", expect: { tool: "xero_search_invoices" } },
  { id: "25", text: "What is the newest email in the finance inbox?", expect: { tool: "outlook_list_messages" } },
  { id: "26", text: "Search info for INV-02268", expect: { scope: "BUSINESS_SYSTEM" } },
  { id: "27", text: "give me more detail", lastTopic: "email", expect: { scope: "GENERAL_CONVERSATION" } },
  { id: "28", text: "What can you help with?", expect: { scope: "CONNECTOR_CAPABILITY" } },
  { id: "29", text: "ok what about finance?", lastTopic: "email", expect: { tool: "outlook_list_messages" } },
  { id: "30", text: "whats our emials in the info inbox", expect: { scope: "BUSINESS_SYSTEM" } },
];

describe("30-turn Portal Chat UX acceptance", () => {
  it("scores conversational routing across 30 turns", async () => {
    let hits = 0;
    const misses: string[] = [];
    for (const turn of TURNS) {
      const decision = classifyScope(
        turn.text,
        buildConversationState({
          userText: turn.text,
          lastAnswerTopic: turn.lastTopic ?? null,
          currentBusinessSystem: turn.lastTopic === "email" ? "email" : turn.lastTopic === "finance" ? "xero" : null,
          lastMailboxAddress: turn.lastTopic === "email" ? "info@elvexpropertyservices.com" : null,
          lastEmailMessageId: turn.lastTopic === "email" ? "msg_1" : null,
        }),
      );
      const ok =
        (!turn.expect?.scope || decision.scope === turn.expect.scope) &&
        (turn.expect?.tool == null || decision.tool === turn.expect.tool) &&
        (turn.expect?.clarify == null || decision.clarify === turn.expect.clarify);
      if (ok) hits += 1;
      else misses.push(`${turn.id} ${turn.text} expected=${JSON.stringify(turn.expect)} got=${decision.scope}/${decision.tool}/${decision.clarify}`);
    }
    if (hits / TURNS.length < 0.9) {
      throw new Error(`Portal UX routing ${hits}/${TURNS.length}\n${misses.join("\n")}`);
    }
    expect(hits).toBeGreaterThanOrEqual(27);
    expect(titleFromUserText("What is the newest email in the info inbox?")).toBe("Latest Info Inbox Email");
  });

  it("does not emit generic retry for weather when web search is unavailable", async () => {
    const result = await runIntelligenceTurn({
      text: "whats the weather in London now",
      state: buildConversationState({ userText: "whats the weather in London now" }),
      runtime: runtime(() => ({
        name: "web_search",
        ok: false,
        latencyMs: 5,
        data: { summary: "Live web access is unavailable just now, so I can’t check current public information." },
        error: "network",
      })),
    });
    expect(isGenericRetryCopy(result.text)).toBe(false);
    expect(result.text).toMatch(/live web access is unavailable/i);
    expect(result.toolCalls[0]?.name).toBe("web_search");
  });

  it("lists newest email instead of searching when the user asks for latest", async () => {
    const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
    const result = await runIntelligenceTurn({
      text: "What is the newest email in the info inbox?",
      state: buildConversationState({ userText: "What is the newest email in the info inbox?" }),
      runtime: runtime((name, args) => {
        seen.push({ name, args });
        return {
          name,
          ok: true,
          latencyMs: 8,
          data: {
            mailboxAddress: String(args.mailboxAddress ?? ""),
            messages: [
              {
                id: "msg_1",
                subject: "Leak detection",
                from: "ops@example.com",
                receivedDateTime: "2026-09-04T09:00:00Z",
                mailboxAddress: args.mailboxAddress,
              },
            ],
          },
        };
      }),
    });
    expect(seen[0]?.name).toBe("outlook_list_messages");
    expect(String(seen[0]?.args.mailboxAddress ?? "")).toMatch(/info@/i);
    expect(Number(seen[0]?.args.limit ?? 0)).toBe(1);
    expect(result.text).toMatch(/Leak detection/i);
    expect(isGenericRetryCopy(result.text)).toBe(false);
  });
});
