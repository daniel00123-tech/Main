import { createCloudflareCompleter } from "./provider.js";
import { isTrueProviderFailure, runOpenAiResponses } from "./openai-responses.js";
import { resolveBrainPolicy, type BrainDecision } from "./brain-policy.js";
import { stripSecretsFromText } from "./evidence.js";
import type { IntelligenceCompleter } from "./provider.js";
import type { IntelligenceEnv } from "./types.js";

export type ReasoningProviderName = "cloudflare" | "openai";

/**
 * Shared control plane stays in runIntelligenceTurn.
 * A provider only supplies reasoning / tool selection / synthesis.
 */
export function createReasoningCompleter(input: {
  env?: IntelligenceEnv;
  companyId?: string | null;
  channel?: string | null;
  correlationId?: string;
  userText?: string;
}): { completer: IntelligenceCompleter; policy: BrainDecision; provider: ReasoningProviderName } {
  const env = input.env ?? {};
  const policy = resolveBrainPolicy({ env, companyId: input.companyId, channel: input.channel });
  const cloudflare = createCloudflareCompleter(env);
  if (!policy.useOpenAi) {
    return { completer: cloudflare, policy, provider: "cloudflare" };
  }
  return {
    completer: createOpenAiCompleter(env, cloudflare, input.correlationId, input.userText),
    policy,
    provider: "openai",
  };
}

export function createOpenAiCompleter(
  env: IntelligenceEnv,
  fallback: IntelligenceCompleter,
  correlationId?: string,
  userText?: string,
): IntelligenceCompleter {
  return async (input) => {
    const openai = await runOpenAiResponses(env, {
      system: stripSecretsFromText(input.system),
      user: stripSecretsFromText(input.user),
      permittedTools: input.permittedTools,
      mode: input.mode,
      correlationId,
      userText,
    });
    if (openai.text || openai.toolCalls?.length || openai.structured) {
      return {
        text: openai.text,
        usage: openai.usage,
        toolCalls: openai.toolCalls,
        structured: openai.structured,
      };
    }
    if (!isTrueProviderFailure(openai.failure)) {
      return { text: openai.text, usage: openai.usage, toolCalls: openai.toolCalls, structured: openai.structured };
    }
    const cloudflare = await fallback(input);
    return {
      ...cloudflare,
      usage: { ...cloudflare.usage, fallbackUsed: true, correlationId: correlationId ?? cloudflare.usage.correlationId },
    };
  };
}

export function createShadowCompleter(env: IntelligenceEnv, correlationId?: string): IntelligenceCompleter {
  const noop: IntelligenceCompleter = async () => ({
    text: "",
    usage: {
      provider: "none",
      model: null,
      latencyMs: 0,
      promptTokens: null,
      completionTokens: null,
      estimatedCostUsd: null,
      costBasis: "unknown",
    },
  });
  return createOpenAiCompleter(env, noop, correlationId);
}
