import type { ResultConfidence } from "./ranking";

export interface SearchGuidanceOptions {
  companyName: string;
  overallConfidence: ResultConfidence;
  resultCount: number;
}

export function buildWeakEvidenceGuidance(
  options: SearchGuidanceOptions
): string | undefined {
  if (options.resultCount === 0) {
    return (
      `No indexed ${options.companyName} knowledge matched this query. ` +
      "Do not invent company-specific facts, policies, or procedures. " +
      "State clearly that no internal evidence was found."
    );
  }

  if (options.overallConfidence === "weak") {
    return (
      `Evidence from ${options.companyName} knowledge is weak for this query. ` +
      "Treat results as tentative. Do not extrapolate unsupported company rules. " +
      "Prefer stating uncertainty over guessing."
    );
  }

  return undefined;
}

export function buildKnowledgeNotConfiguredGuidance(companyName: string): string {
  return (
    `${companyName} knowledge search is not configured. ` +
    "Do not invent internal company documents or policies."
  );
}
