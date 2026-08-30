import type { IntelligenceQualityFlag, IntelligenceTurnResult } from "./types.js";

export function collectQualityFlags(input: {
  result: IntelligenceTurnResult;
  userCorrection?: boolean;
  expectedStayOnDocument?: boolean;
  previousAnswer?: string | null;
}): IntelligenceQualityFlag[] {
  const flags = new Set<IntelligenceQualityFlag>(input.result.qualityFlags ?? []);
  if (input.userCorrection) flags.add("user_correction");
  if (input.result.fallbackUsed || input.result.modelRounds.some((round) => round.fallbackUsed)) {
    flags.add("fallback");
  }
  if (input.result.repaired || input.result.modelRounds.some((round) => round.malformed)) {
    flags.add("malformed_model_response");
  }
  if (
    input.expectedStayOnDocument &&
    input.result.toolCalls.some((call) => call.name === "search_company_knowledge")
  ) {
    flags.add("unnecessary_company_wide_search");
  }
  if (input.result.kind === "failed") flags.add("unsupported_answer");
  if (
    input.previousAnswer &&
    input.result.text.trim() &&
    normalise(input.result.text) === normalise(input.previousAnswer)
  ) {
    flags.add("repeated_answer");
  }
  return [...flags];
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 400);
}
