import { newId, nowIso } from "../../db/mappers";
import type { Env } from "../../env";
import { hasOpenAiApiKey, runOpenAiResponses } from "../intelligence/openai-responses";
import {
  detectRequestedCapabilities,
  capabilityFamily,
  defaultToolForCapability,
} from "../intelligence/company-tool-registry";
import {
  FAILURE_CATEGORIES,
  QUALITY_SCORE_DIMENSIONS,
  type FailureCategory,
  type QualityScoreDimension,
} from "./constants";
import type {
  ConversationTurn,
  DailyImprovementEvaluation,
  DailyImprovementInteraction,
  DimensionScores,
} from "./types";

export function emptyScores(fill = 100): DimensionScores {
  return Object.fromEntries(QUALITY_SCORE_DIMENSIONS.map((key) => [key, fill])) as DimensionScores;
}

export function heuristicEvaluate(input: {
  interaction: DailyImprovementInteraction;
  sequence: ConversationTurn[];
}): Omit<DailyImprovementEvaluation, "id" | "runId" | "createdAt"> {
  const { interaction, sequence } = input;
  const scores = emptyScores(100);
  const failures: FailureCategory[] = [];
  const requested = detectRequestedCapabilities(interaction.userMessage ?? "");
  const requestedFamilies = new Set(requested.map(capabilityFamily));
  requestedFamilies.delete("SYSTEM");
  requestedFamilies.delete("WEB");
  const executed = interaction.toolsExecuted.filter((name) => name && !/^whatsapp\./.test(name));
  const executedFamilies = new Set(
    executed.map((name) => {
      if (name.startsWith("outlook_")) return "EMAIL";
      if (name.startsWith("xero_")) return "ACCOUNTING";
      if (name.includes("knowledge") || name === "search" || name === "fetch") return "KNOWLEDGE";
      if (name.includes("document") || name.includes("list_")) return "CATALOGUE";
      return "OTHER";
    }),
  );

  if (!interaction.assistantAnswer) {
    scores.COMPLETENESS = 40;
    scores.FIRST_ANSWER = 40;
    scores.RELIABILITY = 50;
    failures.push("NO_FINAL_RESPONSE");
  }
  if (requestedFamilies.size >= 2 && executedFamilies.size < 2) {
    scores.TOOL_SELECTION = Math.min(scores.TOOL_SELECTION, 70);
    scores.COMPLETENESS = Math.min(scores.COMPLETENESS, 75);
    failures.push("MIXED_MULTI_TOOL");
  }
  if (requested.includes("ACCOUNTING_INVOICE_SEARCH") && executed.some((name) => name === "xero_sales_summary")) {
    scores.EXACT_TOOL = Math.min(scores.EXACT_TOOL, 70);
    failures.push("XERO_EXACT_TOOL_SELECTION", "WRONG_TOOL");
  }
  if (requested.includes("ACCOUNTING_REPORTS") && executed.some((name) => name === "xero_sales_summary")) {
    scores.EXACT_TOOL = Math.min(scores.EXACT_TOOL, 72);
    failures.push("XERO_EXACT_TOOL_SELECTION");
  }
  if (requestedFamilies.has("EMAIL") && executed.some((name) => name.startsWith("xero_")) && !executed.some((n) => n.startsWith("outlook_"))) {
    scores.TOOL_SELECTION = Math.min(scores.TOOL_SELECTION, 45);
    failures.push("EMAIL_TO_XERO", "WRONG_CAPABILITY");
  }
  if (requestedFamilies.has("ACCOUNTING") && executed.some((name) => name.includes("knowledge")) && !executed.some((n) => n.startsWith("xero_"))) {
    scores.TOOL_SELECTION = Math.min(scores.TOOL_SELECTION, 50);
    failures.push("XERO_TO_KNOWLEDGE", "WRONG_CAPABILITY");
  }
  if (requested.includes("EMAIL_SEARCH") && executed.includes("outlook_list_messages") && !executed.includes("outlook_search_mailbox")) {
    scores.EXACT_TOOL = Math.min(scores.EXACT_TOOL, 65);
    failures.push("LIST_VS_SEARCH");
  }
  if (requested.includes("KNOWLEDGE_SEARCH") && executed.includes("list_documents") && !executed.some((n) => n.includes("knowledge") || n === "search")) {
    scores.EXACT_TOOL = Math.min(scores.EXACT_TOOL, 70);
    failures.push("KNOWLEDGE_VS_CATALOGUE");
  }
  const uniqueExecuted = new Set(executed);
  if (executed.length > uniqueExecuted.size) {
    scores.EFFICIENCY = Math.min(scores.EFFICIENCY, 70);
    failures.push("DUPLICATE_TOOL");
  }
  if ((interaction.latencyMs ?? 0) >= 20_000) {
    scores.RELIABILITY = Math.min(scores.RELIABILITY, 70);
    failures.push("LATENCY_OUTLIER");
  }
  if (/i (don't|do not) have access|permission denied/i.test(interaction.assistantAnswer ?? "") && interaction.terminalState === "ANSWER") {
    scores.RBAC = Math.min(scores.RBAC, 60);
    failures.push("FALSE_PERMISSION_DENIAL");
  }
  if (/no (emails|invoices|results|documents) found/i.test(interaction.assistantAnswer ?? "") && executed.length === 0 && requested.length > 0) {
    scores.GROUNDING = Math.min(scores.GROUNDING, 55);
    failures.push("FALSE_NO_RESULTS", "EXPECTED_TOOL_MISSING");
  }

  const userTexts = sequence.filter((turn) => turn.role === "user").map((turn) => turn.text.toLowerCase().trim());
  const repeats = userTexts.filter((text, index) => index > 0 && userTexts.slice(0, index).some((prior) => similar(prior, text)));
  if (repeats.length > 0) {
    scores.MEMORY = Math.min(scores.MEMORY, 65);
    scores.USER_EFFORT = Math.min(scores.USER_EFFORT, 60);
    scores.FOLLOW_UP = Math.min(scores.FOLLOW_UP, 70);
    failures.push("USER_HAD_TO_REPEAT", "CONTEXT_LOST");
  }
  if (sequence.length >= 3) {
    const firstAssistant = sequence.find((turn) => turn.role === "assistant");
    if (firstAssistant && (firstAssistant.text?.length ?? 0) < 40 && requestedFamilies.size > 0) {
      scores.FIRST_ANSWER = Math.min(scores.FIRST_ANSWER, 75);
      failures.push("FIRST_ANSWER_INCOMPLETE");
    }
  }
  if (interaction.evidenceRefs.some((ref) => ref.companyId && ref.companyId !== interaction.companyId)) {
    scores.RBAC = 0;
    failures.push("CROSS_TENANT_RISK", "PERMISSION_LEAK");
  }

  const overall = Math.round(
    QUALITY_SCORE_DIMENSIONS.reduce((sum, key) => sum + scores[key], 0) / QUALITY_SCORE_DIMENSIONS.length,
  );
  return {
    interactionId: interaction.interactionId,
    conversationId: interaction.conversationId,
    companyId: interaction.companyId,
    channel: interaction.channel,
    overallScore: overall,
    scores,
    failureCategories: uniqueCategories(failures),
    severity: severityOf(failures, overall),
    notes: failures.length ? `Heuristic flags: ${failures.join(", ")}` : "No measurable defect.",
    evaluatorModel: "heuristic-v1",
    evaluatorKind: "heuristic",
    trafficClass: "QUALITY",
    customerChargeCents: 0,
  };
}

export async function evaluateInteraction(
  env: Env,
  input: { interaction: DailyImprovementInteraction; sequence: ConversationTurn[]; runId: string; allowOpenAi?: boolean },
): Promise<DailyImprovementEvaluation> {
  const heuristic = heuristicEvaluate(input);
  let merged = heuristic;
  let kind: DailyImprovementEvaluation["evaluatorKind"] = "heuristic";
  if (input.allowOpenAi !== false && hasOpenAiApiKey(env)) {
    try {
      const openai = await openaiEvaluate(env, input, heuristic);
      merged = mergeEvaluations(heuristic, openai);
      kind = "merged";
    } catch {
      merged = heuristic;
    }
  }
  return {
    ...merged,
    id: newId("die"),
    runId: input.runId,
    evaluatorKind: kind,
    createdAt: nowIso(),
  };
}

async function openaiEvaluate(
  env: Env,
  input: { interaction: DailyImprovementInteraction; sequence: ConversationTurn[] },
  heuristic: ReturnType<typeof heuristicEvaluate>,
): Promise<ReturnType<typeof heuristicEvaluate>> {
  const { interaction, sequence } = input;
  const permitted = interaction.availableCapabilities;
  const result = await runOpenAiResponses(env, {
    mode: "synthesise",
    toolChoice: "none",
    correlationId: `quality_${interaction.interactionId}`,
    system: [
      "You are the INFRA daily quality evaluator.",
      "Score 0-100 for INTENT, TOOL_SELECTION, EXACT_TOOL, RBAC, GROUNDING, FIRST_ANSWER, COMPLETENESS, MEMORY, FOLLOW_UP, NATURALNESS, EFFICIENCY, HALLUCINATION, RELIABILITY, USER_EFFORT.",
      "Judge only against the user request, the tenant's listed capabilities, permissions, tools executed, structured evidence refs, the final answer, and prior turns.",
      "Do not invent what private systems contain. Do not recommend weakening RBAC or rotating secrets.",
      "Return JSON only: {scores:{...}, categories:[], notes, overall}.",
      `Allowed failure categories: ${FAILURE_CATEGORIES.join(", ")}`,
    ].join("\n"),
    user: JSON.stringify({
      userMessage: interaction.userMessage,
      assistantAnswer: interaction.assistantAnswer,
      capabilities: permitted,
      toolsRequested: interaction.toolsRequested,
      toolsExecuted: interaction.toolsExecuted,
      evidenceRefs: interaction.evidenceRefs,
      terminalState: interaction.terminalState,
      sequence: sequence.map((turn) => ({ role: turn.role, text: turn.text.slice(0, 400) })),
      heuristic,
    }),
  });
  const structured = result.structured ?? extractScores(result.text);
  const scores = emptyScores(heuristic.overallScore);
  for (const key of QUALITY_SCORE_DIMENSIONS) {
    const value = Number((structured.scores as Record<string, unknown> | undefined)?.[key]);
    if (Number.isFinite(value)) scores[key] = clamp(value);
  }
  const categories = ((structured.categories as unknown[]) ?? [])
    .filter((item): item is FailureCategory => FAILURE_CATEGORIES.includes(item as FailureCategory));
  const overall = Number(structured.overall);
  return {
    ...heuristic,
    scores,
    overallScore: Number.isFinite(overall) ? clamp(overall) : Math.round(
      QUALITY_SCORE_DIMENSIONS.reduce((sum, key) => sum + scores[key], 0) / QUALITY_SCORE_DIMENSIONS.length,
    ),
    failureCategories: uniqueCategories([...heuristic.failureCategories, ...categories]),
    notes: typeof structured.notes === "string" ? structured.notes.slice(0, 800) : heuristic.notes,
    evaluatorModel: result.usage?.model ?? "openai",
    evaluatorKind: "openai",
  };
}

function mergeEvaluations(
  heuristic: ReturnType<typeof heuristicEvaluate>,
  openai: ReturnType<typeof heuristicEvaluate>,
): ReturnType<typeof heuristicEvaluate> {
  const scores = emptyScores();
  for (const key of QUALITY_SCORE_DIMENSIONS) {
    scores[key] = Math.round((heuristic.scores[key] * 0.4 + openai.scores[key] * 0.6));
  }
  const overall = Math.round(
    QUALITY_SCORE_DIMENSIONS.reduce((sum, key) => sum + scores[key], 0) / QUALITY_SCORE_DIMENSIONS.length,
  );
  return {
    ...openai,
    scores,
    overallScore: overall,
    failureCategories: uniqueCategories([...heuristic.failureCategories, ...openai.failureCategories]),
    severity: severityOf([...heuristic.failureCategories, ...openai.failureCategories], overall),
    evaluatorKind: "openai",
  };
}

function extractScores(text: string): Record<string, unknown> {
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return {};
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function similar(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 8 || b.length < 8) return false;
  return a.includes(b.slice(0, 24)) || b.includes(a.slice(0, 24));
}

function uniqueCategories(items: FailureCategory[]): FailureCategory[] {
  return [...new Set(items)];
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function severityOf(categories: FailureCategory[], overall: number): DailyImprovementEvaluation["severity"] {
  if (categories.includes("CROSS_TENANT_RISK") || categories.includes("PERMISSION_LEAK")) return "CRITICAL";
  if (categories.includes("NO_FINAL_RESPONSE") || categories.includes("BILLING_ERROR") || categories.includes("HALLUCINATION")) {
    return "CRITICAL";
  }
  if (
    categories.includes("EMAIL_TO_XERO") ||
    categories.includes("MIXED_MULTI_TOOL") ||
    categories.includes("XERO_EXACT_TOOL_SELECTION") ||
    categories.includes("FALSE_PERMISSION_DENIAL")
  ) {
    return "HIGH";
  }
  if (overall < 70) return "HIGH";
  if (categories.length && overall < 85) return "MEDIUM";
  if (categories.length) return "LOW";
  return null;
}

export function expectedToolForAsk(text: string): string | null {
  const capabilities = detectRequestedCapabilities(text);
  if (capabilities.length === 0) return null;
  return defaultToolForCapability(capabilities[0]);
}
