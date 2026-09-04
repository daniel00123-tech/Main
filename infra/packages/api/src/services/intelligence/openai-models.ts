/**
 * OpenAI model catalogue verified from official docs on 2026-09-04:
 * https://developers.openai.com/api/docs/models
 *
 * Do not pay reasoning-model cost for trivial turns.
 * gpt-6-astra is the flagship ($10 / $50 per MTok) — never the default.
 */

export type OpenAiModelTier = "fast" | "default" | "reasoning";

export type OpenAiModelSpec = {
  id: string;
  tier: OpenAiModelTier;
  label: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion: number | null;
  notes: string;
};

/** Cost-sensitive high-volume turns (follow-ups, drafts, greetings). */
export const OPENAI_MODEL_FAST = "gpt-5.6-luna";
/** Balanced intelligence for normal Portal / WhatsApp turns. */
export const OPENAI_MODEL_DEFAULT = "gpt-5.6-terra";
/** Complex multi-system synthesis only. */
export const OPENAI_MODEL_REASONING = "gpt-5.6-sol";

export const OPENAI_MODELS: OpenAiModelSpec[] = [
  {
    id: OPENAI_MODEL_FAST,
    tier: "fast",
    label: "GPT-5.6 Luna",
    inputUsdPerMillion: 0.2,
    outputUsdPerMillion: 1.2,
    cachedInputUsdPerMillion: null,
    notes: "Cost-sensitive. Official 2026-09-04 catalogue.",
  },
  {
    id: OPENAI_MODEL_DEFAULT,
    tier: "default",
    label: "GPT-5.6 Terra",
    inputUsdPerMillion: 2,
    outputUsdPerMillion: 12,
    cachedInputUsdPerMillion: null,
    notes: "Balanced default. Official 2026-09-04 catalogue.",
  },
  {
    id: OPENAI_MODEL_REASONING,
    tier: "reasoning",
    label: "GPT-5.6 Sol",
    inputUsdPerMillion: 4,
    outputUsdPerMillion: 20,
    cachedInputUsdPerMillion: null,
    notes: "Complex professional work. Alias gpt-5.6. Official 2026-09-04 catalogue.",
  },
];

export function openAiModelSpec(id: string | null | undefined): OpenAiModelSpec | null {
  const key = String(id ?? "").trim();
  return OPENAI_MODELS.find((model) => model.id === key) ?? null;
}

export function resolveOpenAiModel(
  env: {
    OPENAI_MODEL_FAST?: string;
    OPENAI_MODEL_DEFAULT?: string;
    OPENAI_MODEL_REASONING?: string;
  },
  tier: OpenAiModelTier,
): string {
  if (tier === "fast") return String(env.OPENAI_MODEL_FAST ?? "").trim() || OPENAI_MODEL_FAST;
  if (tier === "reasoning") return String(env.OPENAI_MODEL_REASONING ?? "").trim() || OPENAI_MODEL_REASONING;
  return String(env.OPENAI_MODEL_DEFAULT ?? "").trim() || OPENAI_MODEL_DEFAULT;
}

export function pickOpenAiTier(input: {
  mode?: "decide" | "repair" | "synthesise";
  userText?: string;
  hasFreshBusinessQuestion?: boolean;
}): OpenAiModelTier {
  const text = String(input.userText ?? "");
  if (input.mode === "repair" || input.mode === "synthesise") return "fast";
  if (
    /^(hi|hello|hey|thanks|thank you|cheers)\b/i.test(text.trim()) ||
    /\b(make (that|it|this).{0,24}(short|brief|friendly|warmer)|what were (we|they)|say that again)\b/i.test(text)
  ) {
    return "fast";
  }
  if (
    input.hasFreshBusinessQuestion &&
    /\b(compare|versus|why|explain|analyse|analyze|reconcile)\b/i.test(text) &&
    text.split(/\s+/).length > 18
  ) {
    return "reasoning";
  }
  return "default";
}

export function estimateOpenAiCostUsd(input: {
  model: string | null | undefined;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens?: number | null;
}): { estimatedCostUsd: number | null; costBasis: "estimated" | "unknown" } {
  const spec = openAiModelSpec(input.model);
  if (!spec || input.inputTokens == null || input.outputTokens == null) {
    return { estimatedCostUsd: null, costBasis: "unknown" };
  }
  const cached = Math.min(input.cachedTokens ?? 0, input.inputTokens);
  const uncached = Math.max(0, input.inputTokens - cached);
  const cachedRate = spec.cachedInputUsdPerMillion ?? spec.inputUsdPerMillion;
  const usd =
    (uncached / 1_000_000) * spec.inputUsdPerMillion +
    (cached / 1_000_000) * cachedRate +
    (input.outputTokens / 1_000_000) * spec.outputUsdPerMillion;
  return { estimatedCostUsd: usd, costBasis: "estimated" };
}
