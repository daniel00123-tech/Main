import { describe, expect, it } from "vitest";
import { runIntelligenceTurn } from "./orchestrator.js";
import { buildConversationState } from "./state.js";
import { extractEvidenceFromTools } from "./evidence.js";
import type { IntelligenceRuntime, IntelligenceToolResult } from "./types.js";

const EMAIL = {
  mailboxAddress: "info@elvexpropertyservices.com",
  messages: [
    {
      id: "msg_leak",
      subject: "Leak detection quote",
      from: { emailAddress: { address: "ops@example.com", name: "Ops" } },
      receivedDateTime: "2026-09-04T09:11:00Z",
      body: "Please can you confirm availability for a leak survey next Tuesday?",
    },
  ],
};

function countingRuntime(): { runtime: IntelligenceRuntime; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runtime: {
      async executeTool(call): Promise<IntelligenceToolResult> {
        calls.push(call.name);
        if (call.name.startsWith("outlook_")) {
          return { name: call.name, ok: true, latencyMs: 8, data: EMAIL };
        }
        if (call.name.startsWith("xero_")) {
          return {
            name: call.name,
            ok: true,
            latencyMs: 8,
            data: { sales_total: 5094, invoice_count: 32, period: { fromDate: "2026-09-01", toDate: "2026-09-04" } },
          };
        }
        return { name: call.name, ok: true, latencyMs: 4, data: { results: [] } };
      },
    },
  };
}

describe("EL email follow-up reliability", () => {
  it("fetches Outlook once then drafts and edits from retained evidence", async () => {
    const { runtime, calls } = countingRuntime();
    const connectors = ["conn_xero", "conn_outlook_shared", "conn_microsoft"];
    const first = await runIntelligenceTurn({
      text: "check in the info inbox what is the latest email",
      state: buildConversationState({ userText: "check in the info inbox what is the latest email", connectors }),
      runtime,
    });
    expect(first.toolCalls.filter((call) => call.name.startsWith("outlook_")).length).toBeGreaterThanOrEqual(1);
    expect(first.text).toMatch(/Leak detection/i);
    const outlookAfterFirst = calls.filter((name) => name.startsWith("outlook_")).length;
    expect(outlookAfterFirst).toBeGreaterThanOrEqual(1);
    expect(outlookAfterFirst).toBeLessThanOrEqual(2);

    const evidence = extractEvidenceFromTools(first.toolCalls);
    const second = await runIntelligenceTurn({
      text: "ok great and can we do anything with that email, give a suggestion on what to reply?",
      state: buildConversationState({
        userText: "ok great and can we do anything with that email, give a suggestion on what to reply?",
        connectors,
        lastAnswerTopic: "email",
        currentBusinessSystem: "email",
        lastAnswerText: first.text,
        lastSuccessfulTool: "outlook_list_messages",
        recentEvidence: evidence,
        recentTurns: [
          { role: "user", text: "check in the info inbox what is the latest email" },
          { role: "assistant", text: first.text },
        ],
      }),
      runtime,
    });
    expect(second.toolCalls.filter((call) => call.name.startsWith("outlook_"))).toHaveLength(0);
    expect(second.text).toMatch(/Suggested reply|Thanks for your email|leak/i);

    const shorter = await runIntelligenceTurn({
      text: "make that shorter",
      state: buildConversationState({
        userText: "make that shorter",
        connectors,
        lastAnswerTopic: "email",
        currentBusinessSystem: "email",
        lastAnswerText: second.text,
        recentEvidence: second.recentEvidence ?? evidence,
        recentTurns: [
          { role: "user", text: "give a suggestion on what to reply?" },
          { role: "assistant", text: second.text },
        ],
      }),
      runtime,
    });
    expect(shorter.toolCalls).toHaveLength(0);
    expect(shorter.text.length).toBeLessThan(second.text.length);

    const friendlier = await runIntelligenceTurn({
      text: "make it friendlier",
      state: buildConversationState({
        userText: "make it friendlier",
        connectors,
        lastAnswerTopic: "email",
        lastAnswerText: shorter.text,
        recentEvidence: evidence,
      }),
      runtime,
    });
    expect(friendlier.toolCalls).toHaveLength(0);
    expect(friendlier.text).toBeTruthy();

    const asking = await runIntelligenceTurn({
      text: "what were they asking for again?",
      state: buildConversationState({
        userText: "what were they asking for again?",
        connectors,
        lastAnswerTopic: "email",
        lastAnswerText: friendlier.text,
        recentEvidence: evidence,
      }),
      runtime,
    });
    expect(asking.toolCalls).toHaveLength(0);
    expect(asking.text).toMatch(/leak|availability|survey/i);
    expect(calls.filter((name) => name.startsWith("outlook_")).length).toBe(outlookAfterFirst);
  });

  it("keeps OpenAI off and Cloudflare available when the secret is missing", async () => {
    const { runtime } = countingRuntime();
    const result = await runIntelligenceTurn({
      env: { OPENAI_BRAIN_ENABLED: "true", OPENAI_BRAIN_MODE: "openai_primary" },
      text: "thanks",
      state: buildConversationState({ userText: "thanks", companyId: "co_el" }),
      runtime,
    });
    expect(result.brainMode ?? "cloudflare").toBe("cloudflare");
    expect(result.text).toMatch(/welcome|thanks|help/i);
  });
});
