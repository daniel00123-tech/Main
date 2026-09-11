import { describe, expect, it } from "vitest";
import { resolveBrainPolicy } from "./brain-policy.js";
import {
  createReasoningProviderRegistry,
  reasoningProviderNames,
  resolveReasoningProvider,
} from "./provider-registry.js";
import { inspectXaiConfig, runXaiResponses } from "./xai-responses.js";
import type { IntelligenceCompleter } from "./provider.js";

const fallback: IntelligenceCompleter = async () => ({
  text: JSON.stringify({ action: "answer", text: "Cloudflare fallback", confidence: "strong", offer_search_other: false, cite_source: false }),
  structured: { action: "answer", text: "Cloudflare fallback", confidence: "strong", offer_search_other: false, cite_source: false },
  usage: {
    provider: "workers-ai",
    model: "@cf/test",
    latencyMs: 1,
    promptTokens: 1,
    completionTokens: 1,
    estimatedCostUsd: 0,
    costBasis: "estimated",
  },
});

describe("reasoning provider registry", () => {
  it("registers Cloudflare, OpenAI, and xAI behind the same resolver", () => {
    expect(reasoningProviderNames()).toEqual(["cloudflare", "openai", "xai"]);
    const registry = createReasoningProviderRegistry({
      env: {
        OPENAI_API_KEY: "sk-test-key-1234567890abcdef",
        XAI_API_KEY: "xai-test-key-1234567890abcdef",
        XAI_MODEL_DEFAULT: "grok-test",
      },
      fallback,
    });
    expect(resolveReasoningProvider(registry, "cloudflare").name).toBe("cloudflare");
    expect(resolveReasoningProvider(registry, "openai").name).toBe("openai");
    expect(resolveReasoningProvider(registry, "xai").name).toBe("xai");
    expect(registry.xai.configured).toBe(true);
  });

  it("keeps xAI as a non-production adapter that falls back safely", async () => {
    const registry = createReasoningProviderRegistry({
      env: {
        XAI_API_KEY: "xai-test-key-1234567890abcdef",
        XAI_BRAIN_ENABLED: "true",
      },
      fallback,
      correlationId: "corr_xai",
    });
    const selected = resolveReasoningProvider(registry, "xai");
    const result = await selected.completer({ system: "You are INFRA.", user: "hello" });
    expect(selected.name).toBe("xai");
    expect(result.text).toContain("Cloudflare fallback");
    expect(result.usage.provider).toBe("workers-ai");
    expect(result.usage.fallbackUsed).toBe(true);
    expect(result.usage.correlationId).toBe("corr_xai");
  });

  it("exposes placeholder xAI config without promoting production policy", async () => {
    const env = {
      XAI_API_KEY: "xai-test-key-1234567890abcdef",
      XAI_MODEL_DEFAULT: "grok-test",
      OPENAI_API_KEY: "sk-test-key-1234567890abcdef",
      OPENAI_BRAIN_ENABLED: "true",
      OPENAI_BRAIN_MODE: "openai_primary",
      OPENAI_BRAIN_COMPANY_IDS: "co_el",
    };
    expect(inspectXaiConfig(env).model).toBe("grok-test");
    expect((await runXaiResponses(env)).failure).toBe("disabled");
    expect(resolveBrainPolicy({ env, companyId: "co_newco", channel: "portal_chat" }).userVisibleBrain).toBe("cloudflare");
    expect(resolveBrainPolicy({ env, companyId: "co_el", channel: "portal_chat" }).userVisibleBrain).toBe("openai");
  });
});
