/**
 * Tenant-independent complexity router. Picks a model tier, not a company.
 */

import { pickOpenAiTier, type OpenAiModelTier } from "./openai-models.js";
import { detectRequestedCapabilities } from "./company-tool-registry.js";

export type ComplexityClass = "fast_local" | "standard_planning" | "high_complexity" | "evidence_only";

export function classifyTurnComplexity(input: {
  userText?: string;
  hasFreshBusinessQuestion?: boolean;
  canAnswerFromEvidence?: boolean;
}): ComplexityClass {
  const text = String(input.userText ?? "").trim();
  if (!text || /^(hi|hello|hey|thanks|thank you|cheers)[.!]?$/i.test(text)) return "fast_local";
  if (input.canAnswerFromEvidence) return "evidence_only";
  const capabilities = detectRequestedCapabilities(text);
  const words = text.split(/\s+/).length;
  if (
    capabilities.length >= 2 ||
    (words > 12 && /\b(compare|versus|explain|recommend|analyse|analyze|reconcile)\b/i.test(text))
  ) {
    return "high_complexity";
  }
  if (capabilities.length > 0 || input.hasFreshBusinessQuestion) return "standard_planning";
  return "fast_local";
}

export function recommendModelTier(input: {
  userText?: string;
  hasFreshBusinessQuestion?: boolean;
  canAnswerFromEvidence?: boolean;
  mode?: "decide" | "repair" | "synthesise";
}): OpenAiModelTier {
  const complexity = classifyTurnComplexity(input);
  if (input.mode === "repair" || input.mode === "synthesise" || complexity === "evidence_only") return "fast";
  if (complexity === "high_complexity") return "reasoning";
  if (complexity === "fast_local") return "fast";
  return pickOpenAiTier({
    mode: input.mode,
    userText: input.userText,
    hasFreshBusinessQuestion: input.hasFreshBusinessQuestion,
  });
}
