import { describe, expect, it } from "vitest";
import { runIntelligenceTurn } from "./orchestrator.js";
import { buildConversationState } from "./state.js";
import { publicShadowFields, runOpenAiConnectivitySmoke, shouldRunOpenAiShadow } from "./shadow-eval.js";
import type { IntelligenceRuntime, IntelligenceToolResult } from "./types.js";

function runtime(): IntelligenceRuntime {
  return {
    async executeTool(call): Promise<IntelligenceToolResult> {
      return { name: call.name, ok: true, latencyMs: 1, data: {} };
    },
  };
}

describe("OpenAI shadow eval", () => {
  it("does not run shadow when a completer is injected", () => {
    expect(
      shouldRunOpenAiShadow({
        env: {
          OPENAI_API_KEY: "sk-test-key-1234567890abcdef",
          OPENAI_BRAIN_ENABLED: "true",
          OPENAI_BRAIN_MODE: "openai_shadow",
        },
        companyId: "co_el",
        completerInjected: true,
      }),
    ).toBe(false);
  });

  it("does not double-call OpenAI when PA or request already use it", () => {
    const env = {
      OPENAI_API_KEY: "sk-test-key-1234567890abcdef",
      OPENAI_BRAIN_ENABLED: "true",
      OPENAI_BRAIN_MODE: "openai_shadow",
      OPENAI_BRAIN_COMPANY_IDS: "co_el",
    };
    expect(shouldRunOpenAiShadow({ env, companyId: "co_el", channel: "portal_chat" })).toBe(false);
    expect(shouldRunOpenAiShadow({ env, companyId: "co_el", channel: "whatsapp" })).toBe(false);
    expect(shouldRunOpenAiShadow({ env, companyId: "co_el" })).toBe(true);
  });

  it("keeps the Cloudflare answer when OpenAI is only shadowing", async () => {
    const result = await runIntelligenceTurn({
      env: { OPENAI_BRAIN_ENABLED: "true", OPENAI_BRAIN_MODE: "openai_shadow" },
      text: "thanks",
      state: buildConversationState({ userText: "thanks", companyId: "co_el" }),
      runtime: runtime(),
    });
    expect(result.text).toBeTruthy();
    expect(result.text).not.toMatch(/shadow/i);
    expect(result.shadowEval ?? null).toBeNull();
  });

  it("classifies a missing-key smoke without leaking secrets", async () => {
    const smoke = await runOpenAiConnectivitySmoke({});
    expect(smoke.success).toBe(false);
    expect(smoke.failure).toBe("missing_key");
    expect(smoke.keyConfigured).toBe(false);
    expect(smoke.businessConnectorsUsed).toBe(false);
    expect(JSON.stringify(smoke)).not.toMatch(/sk-|Bearer /);
  });

  it("never exposes shadow answer text in public metadata fields", () => {
    const fields = publicShadowFields({
      provider: "openai",
      model: "gpt-5.6-luna",
      latencyMs: 12,
      promptTokens: 8,
      completionTokens: 1,
      cachedTokens: 0,
      estimatedCostUsd: 0,
      costBasis: "estimated",
      correlationId: "corr",
      toolProposal: ["outlook_list_messages"],
      failure: null,
      reusedEvidence: true,
      executedLiveTools: false,
      userVisibleProvider: "cloudflare",
    });
    expect(JSON.stringify(fields)).not.toMatch(/Sorry|Hi Ops|leak/);
    expect(fields.shadowToolProposal).toEqual(["outlook_list_messages"]);
  });
});
