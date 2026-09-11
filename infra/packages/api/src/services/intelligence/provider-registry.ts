import { createCloudflareCompleter } from "./provider.js";
import { isTrueProviderFailure, runOpenAiResponses } from "./openai-responses.js";
import { inspectXaiConfig, runXaiResponses } from "./xai-responses.js";
import { stripSecretsFromText } from "./evidence.js";
import type { IntelligenceCompleter } from "./provider.js";
import type { BrainProviderName, IntelligenceEnv } from "./types.js";

export type ReasoningProviderName = BrainProviderName;

export type ReasoningProviderAdapter = {
  name: ReasoningProviderName;
  configured: boolean;
  createCompleter(): IntelligenceCompleter;
};

export type ReasoningProviderSelection = {
  name: ReasoningProviderName;
  completer: IntelligenceCompleter;
  configured: boolean;
};

export function createReasoningProviderRegistry(input: {
  env: IntelligenceEnv;
  fallback?: IntelligenceCompleter;
  correlationId?: string;
  userText?: string;
}): Record<ReasoningProviderName, ReasoningProviderAdapter> {
  const cloudflare = input.fallback ?? createCloudflareCompleter(input.env);
  return {
    cloudflare: {
      name: "cloudflare",
      configured: Boolean(input.env.AI),
      createCompleter: () => cloudflare,
    },
    openai: {
      name: "openai",
      configured: String(input.env.OPENAI_API_KEY ?? "").trim().length >= 20,
      createCompleter: () => createOpenAiCompleter(input.env, cloudflare, input.correlationId, input.userText),
    },
    xai: {
      name: "xai",
      configured: inspectXaiConfig(input.env).configured,
      createCompleter: () => createXaiCompleter(input.env, cloudflare, input.correlationId),
    },
  };
}

export function reasoningProviderNames(): ReasoningProviderName[] {
  return ["cloudflare", "openai", "xai"];
}

export function resolveReasoningProvider(
  registry: Record<ReasoningProviderName, ReasoningProviderAdapter>,
  requested: ReasoningProviderName,
): ReasoningProviderSelection {
  const adapter = registry[requested] ?? registry.cloudflare;
  return {
    name: adapter.name,
    configured: adapter.configured,
    completer: adapter.createCompleter(),
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

export function createXaiCompleter(
  env: IntelligenceEnv,
  fallback: IntelligenceCompleter,
  correlationId?: string,
): IntelligenceCompleter {
  return async (input) => {
    const xai = await runXaiResponses(env);
    const cloudflare = await fallback(input);
    return {
      ...cloudflare,
      usage: {
        ...cloudflare.usage,
        fallbackUsed: true,
        correlationId: correlationId ?? cloudflare.usage.correlationId,
      },
      structured: cloudflare.structured,
      toolCalls: cloudflare.toolCalls,
      text: cloudflare.text || xai.text,
    };
  };
}
