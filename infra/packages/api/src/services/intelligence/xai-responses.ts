import type { IntelligenceEnv, IntelligenceModelUsage } from "./types.js";

export const DEFAULT_XAI_TEXT_MODEL = "grok-2-latest";

export type XaiProviderFailure =
  | "missing_key"
  | "disabled"
  | "not_implemented";

export type XaiResponsesResult = {
  text: string;
  usage: IntelligenceModelUsage;
  failure: XaiProviderFailure;
};

export function hasXaiApiKey(env: IntelligenceEnv): boolean {
  return String(env.XAI_API_KEY ?? "").trim().length >= 20;
}

export function resolveXaiModel(env: IntelligenceEnv): string {
  return String(env.XAI_MODEL_DEFAULT ?? "").trim() || DEFAULT_XAI_TEXT_MODEL;
}

export function inspectXaiConfig(env: IntelligenceEnv): {
  configured: boolean;
  enabled: boolean;
  baseUrl: string;
  model: string;
} {
  return {
    configured: hasXaiApiKey(env),
    enabled: /^(1|true|yes)$/i.test(String(env.XAI_BRAIN_ENABLED ?? "").trim()),
    baseUrl: String(env.XAI_BASE_URL ?? "").trim() || "https://api.x.ai",
    model: resolveXaiModel(env),
  };
}

/**
 * Registry placeholder for xAI. It proves the adapter seam without sending
 * production traffic to xAI before a live contract, key policy, and rollout are approved.
 */
export async function runXaiResponses(env: IntelligenceEnv): Promise<XaiResponsesResult> {
  const started = Date.now();
  const config = inspectXaiConfig(env);
  const failure: XaiProviderFailure = !config.configured
    ? "missing_key"
    : !config.enabled
      ? "disabled"
      : "not_implemented";
  return {
    text: "",
    usage: {
      provider: "xai",
      model: config.model,
      latencyMs: Date.now() - started,
      promptTokens: null,
      completionTokens: null,
      estimatedCostUsd: null,
      costBasis: "unknown",
      fallbackUsed: false,
      malformed: true,
    },
    failure,
  };
}
