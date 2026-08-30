import type { IntelligenceQualityFlag, IntelligenceScope, IntelligenceTurnResult } from "./types.js";
import { advertisedMissingConnector, inventedCount } from "./system-meta.js";
import { SYSTEM_META_TOOLS } from "./catalogue.js";

export function collectQualityFlags(input: {
  result: IntelligenceTurnResult;
  userCorrection?: boolean;
  expectedStayOnDocument?: boolean;
  previousAnswer?: string | null;
  scope?: IntelligenceScope | null;
  connectors?: string[];
  scopeSwitch?: boolean;
  rephrase?: boolean;
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

  const tools = input.result.toolCalls.map((call) => call.name);
  const scope = input.scope ?? input.result.scope;
  if (scope === "SYSTEM_META" && tools.some((name) => name === "search_document")) {
    flags.add("system_question_as_current_doc");
  }
  if (scope === "GENERAL_CONVERSATION" && tools.length > 0) {
    flags.add("general_conversation_used_tool");
  }
  if (input.rephrase && tools.some((name) => name === "search_document" || name === "search_company_knowledge")) {
    flags.add("unnecessary_search_after_rephrase");
  }
  if (scope === "AMBIGUOUS" && input.result.kind === "answer" && !input.result.clarification) {
    flags.add("ambiguous_answered_without_clarify");
  }
  if (input.scopeSwitch && tools.includes("search_document")) {
    flags.add("scope_switch_ignored");
    flags.add("current_doc_retained_after_switch");
  }
  if (input.userCorrection && tools.includes("search_document") && scope !== "CURRENT_DOCUMENT") {
    flags.add("correction_ignored");
  }
  if (advertisedMissingConnector(input.result.text, input.connectors ?? [])) {
    flags.add("connector_hallucinated");
  }
  const meta = input.result.toolCalls.find((call) => SYSTEM_META_TOOLS.has(call.name));
  if (meta?.data && inventedCount(input.result.text, meta.data)) {
    flags.add("count_invented");
  }
  return [...flags];
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 400);
}
