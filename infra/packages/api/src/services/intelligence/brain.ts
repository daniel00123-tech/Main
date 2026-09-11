import { createCloudflareCompleter } from "./provider.js";
import { resolveBrainPolicy, type BrainDecision } from "./brain-policy.js";
import {
  createOpenAiCompleter,
  createReasoningProviderRegistry,
  resolveReasoningProvider,
  type ReasoningProviderName,
} from "./provider-registry.js";
import type { IntelligenceCompleter } from "./provider.js";
import type { IntelligenceEnv } from "./types.js";

export type { ReasoningProviderName };
export { createOpenAiCompleter };

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
  const registry = createReasoningProviderRegistry({
    env,
    fallback: cloudflare,
    correlationId: input.correlationId,
    userText: input.userText,
  });
  const selected = resolveReasoningProvider(registry, policy.userVisibleBrain);
  return {
    completer: selected.completer,
    policy,
    provider: selected.name,
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
