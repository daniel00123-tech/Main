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
  type DailyImprovementSeverity,
  type FailureCategory,
  type QualityScoreDimension,
} from "./constants";
import { severityForCause } from "./thresholds";
import type {
  ConversationTurn,
  DailyImprovementEvaluation,
  DailyImprovementInteraction,
  DimensionScores,
  QualityFinding,
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
  const findings: QualityFinding[] = [];
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
  const evidenceId = interaction.correlationId ?? interaction.interactionId;

  if (!interaction.assistantAnswer) {
    scores.COMPLETENESS = 40;
    scores.FIRST_ANSWER = 40;
    scores.RELIABILITY = 50;
    pushFinding(failures, findings, {
      category: "NO_FINAL_RESPONSE",
      expected: "A grounded final answer on the first authorised turn.",
      actual: "No assistant answer was stored.",
      evidence: evidenceId,
      rootCause: "Turn ended without a final response.",
      impact: "User received nothing usable.",
    });
  }
  if (requestedFamilies.size >= 2 && executedFamilies.size < 2) {
    scores.TOOL_SELECTION = Math.min(scores.TOOL_SELECTION, 70);
    scores.COMPLETENESS = Math.min(scores.COMPLETENESS, 75);
    pushFinding(failures, findings, {
      category: "MIXED_MULTI_TOOL",
      expected: "Execute every requested authorised capability family and synthesise one answer.",
      actual: `Requested ${[...requestedFamilies].join(", ")} but executed ${[...executedFamilies].join(", ") || "none"}.`,
      evidence: evidenceId,
      rootCause: "Planner under-selected a second live capability.",
      impact: "Compound ask is only half-answered.",
    });
  }
  if (requested.includes("ACCOUNTING_INVOICE_SEARCH") && executed.some((name) => name === "xero_sales_summary")) {
    scores.EXACT_TOOL = Math.min(scores.EXACT_TOOL, 70);
    pushFinding(failures, findings, {
      category: "XERO_EXACT_TOOL_SELECTION",
      expected: "Outstanding / unpaid / invoice search maps to the invoice-search family.",
      actual: "Sales-summary family ran instead.",
      evidence: evidenceId,
      rootCause: "Accounting language collapsed to ACCOUNTING_SALES.",
      impact: "Wrong Xero view.",
    });
    failures.push("WRONG_TOOL");
  }
  if (requested.includes("ACCOUNTING_REPORTS") && executed.some((name) => name === "xero_sales_summary")) {
    scores.EXACT_TOOL = Math.min(scores.EXACT_TOOL, 72);
    pushFinding(failures, findings, {
      category: "XERO_EXACT_TOOL_SELECTION",
      expected: "P&L / aged / balance-sheet asks use the reports family.",
      actual: "Sales-summary family ran instead.",
      evidence: evidenceId,
      rootCause: "Report language collapsed to ACCOUNTING_SALES.",
      impact: "Wrong accounting artefact.",
    });
  }
  if (requestedFamilies.has("EMAIL") && executed.some((name) => name.startsWith("xero_")) && !executed.some((n) => n.startsWith("outlook_"))) {
    scores.TOOL_SELECTION = Math.min(scores.TOOL_SELECTION, 45);
    pushFinding(failures, findings, {
      category: "EMAIL_TO_XERO",
      expected: "Mailbox asks stay on Outlook.",
      actual: "A Xero tool ran and no Outlook tool ran.",
      evidence: evidenceId,
      rootCause: "Mailbox invoice/search language leaked into accounting routing.",
      impact: "Wrong business system.",
    });
    failures.push("WRONG_CAPABILITY");
  }
  if (requestedFamilies.has("ACCOUNTING") && executed.some((name) => name.includes("knowledge")) && !executed.some((n) => n.startsWith("xero_"))) {
    scores.TOOL_SELECTION = Math.min(scores.TOOL_SELECTION, 50);
    pushFinding(failures, findings, {
      category: "XERO_TO_KNOWLEDGE",
      expected: "Live accounting asks hit Xero, not knowledge search.",
      actual: "Knowledge/catalogue ran without a Xero tool.",
      evidence: evidenceId,
      rootCause: "Fresh accounting ask fell through to documents.",
      impact: "Stale or missing figures.",
    });
    failures.push("WRONG_CAPABILITY");
  }
  if (requested.includes("EMAIL_SEARCH") && executed.includes("outlook_list_messages") && !executed.includes("outlook_search_mailbox")) {
    scores.EXACT_TOOL = Math.min(scores.EXACT_TOOL, 65);
    pushFinding(failures, findings, {
      category: "LIST_VS_SEARCH",
      expected: "Search language uses mailbox search.",
      actual: "List-messages ran instead of search.",
      evidence: evidenceId,
      rootCause: "List vs search detector missed the search intent.",
      impact: "Wrong mailbox slice.",
    });
  }
  if (requested.includes("KNOWLEDGE_SEARCH") && executed.includes("list_documents") && !executed.some((n) => n.includes("knowledge") || n === "search")) {
    scores.EXACT_TOOL = Math.min(scores.EXACT_TOOL, 70);
    pushFinding(failures, findings, {
      category: "KNOWLEDGE_VS_CATALOGUE",
      expected: "Knowledge questions search indexed content, not only the catalogue list.",
      actual: "list_documents ran without a knowledge search.",
      evidence: evidenceId,
      rootCause: "Catalogue vs knowledge family confusion.",
      impact: "Missing document answer.",
    });
  }
  const uniqueExecuted = new Set(executed);
  if (executed.length > uniqueExecuted.size) {
    scores.EFFICIENCY = Math.min(scores.EFFICIENCY, 70);
    pushFinding(failures, findings, {
      category: "DUPLICATE_TOOL",
      expected: "Each needed tool runs once.",
      actual: "The same tool executed more than once.",
      evidence: evidenceId,
      rootCause: "Planner retried an already-successful tool.",
      impact: "Extra latency and noise.",
    });
  }
  if ((interaction.latencyMs ?? 0) >= 20_000) {
    scores.RELIABILITY = Math.min(scores.RELIABILITY, 70);
    pushFinding(failures, findings, {
      category: "LATENCY_OUTLIER",
      expected: "Customer turns complete within the agreed latency budget.",
      actual: `Latency ${interaction.latencyMs}ms.`,
      evidence: evidenceId,
      rootCause: "Slow provider or tool fan-out.",
      impact: "User waits too long.",
    });
  }

  const denialText = /i (don't|do not) have access|permission denied|not authorised|not authorized/i.test(
    interaction.assistantAnswer ?? "",
  );
  const expectedDenial =
    /permission_denied|denied|rbac/i.test(interaction.terminalState ?? "") ||
    /permission_denied|expected_denial/i.test(interaction.qualityResult ?? "");
  if (denialText && expectedDenial) {
    pushFinding(failures, findings, {
      category: "EXPECTED_PERMISSION_DENIAL",
      expected: "Correct RBAC denial when the role lacks the capability.",
      actual: "Assistant denied access and the turn was recorded as a permission denial.",
      evidence: evidenceId,
      rootCause: "Policy working as designed.",
      impact: "None — expected denial is not a defect.",
      severity: "LOW",
    });
  } else if (denialText && interaction.terminalState === "ANSWER") {
    scores.RBAC = Math.min(scores.RBAC, 60);
    pushFinding(failures, findings, {
      category: "FALSE_PERMISSION_DENIAL",
      expected: "If the role is authorised, answer from the live system. Do not invent a denial.",
      actual: "Answer claimed a permission denial on a completed ANSWER turn.",
      evidence: evidenceId,
      rootCause: "Response contradicted the authorised catalogue.",
      impact: "False refusal of a legitimate ask.",
    });
    failures.push("RBAC_RESPONSE_CONTRADICTION");
  }
  if (/no (emails|invoices|results|documents) found/i.test(interaction.assistantAnswer ?? "") && executed.length === 0 && requested.length > 0) {
    scores.GROUNDING = Math.min(scores.GROUNDING, 55);
    pushFinding(failures, findings, {
      category: "FALSE_NO_RESULTS",
      expected: "Look in the authorised live system before claiming there are no results.",
      actual: "Claimed no results without executing a tool.",
      evidence: evidenceId,
      rootCause: "Empty-result short-circuit.",
      impact: "User is told the system is empty when it was never queried.",
    });
    failures.push("EXPECTED_TOOL_MISSING");
  }
  if (
    /£\s?\d|\$\s?\d|\d+\.\d{2}/.test(interaction.assistantAnswer ?? "") &&
    executed.length === 0 &&
    interaction.evidenceRefs.length === 0 &&
    /invoice|sales|overdue|revenue|email|document|xero/i.test(interaction.userMessage ?? "")
  ) {
    scores.HALLUCINATION = Math.min(scores.HALLUCINATION, 40);
    scores.GROUNDING = Math.min(scores.GROUNDING, 40);
    pushFinding(failures, findings, {
      category: "HALLUCINATION",
      expected: "Business figures only from retrieved evidence.",
      actual: "Numeric/business claim with no tool evidence.",
      evidence: evidenceId,
      rootCause: "Synthesis invented a figure.",
      impact: "Unsupported business claim.",
    });
  }

  const userTexts = sequence.filter((turn) => turn.role === "user").map((turn) => turn.text.toLowerCase().trim());
  const repeats = userTexts.filter((text, index) => index > 0 && userTexts.slice(0, index).some((prior) => similar(prior, text)));
  if (repeats.length > 0) {
    scores.MEMORY = Math.min(scores.MEMORY, 65);
    scores.USER_EFFORT = Math.min(scores.USER_EFFORT, 60);
    scores.FOLLOW_UP = Math.min(scores.FOLLOW_UP, 70);
    pushFinding(failures, findings, {
      category: "USER_HAD_TO_REPEAT",
      expected: "The first answer makes a restatement unnecessary.",
      actual: "User repeated or near-repeated an earlier ask.",
      evidence: evidenceId,
      rootCause: "First answer was unusable or context was dropped.",
      impact: "Extra user effort.",
    });
    failures.push("CONTEXT_LOST", "EXCESSIVE_USER_REPAIR");
  }
  const latestUser = (interaction.userMessage ?? "").toLowerCase();
  if (/i meant|no i said|wrong (tool|system|file|data)|that(?:'| i)?s not|switch to|use (email|outlook|xero)/i.test(latestUser)) {
    scores.FOLLOW_UP = Math.min(scores.FOLLOW_UP, 68);
    scores.MEMORY = Math.min(scores.MEMORY, 70);
    pushFinding(failures, findings, {
      category: "CORRECTION_NOT_REPLANNED",
      expected: "A correction replans the intended authorised capability.",
      actual: "User corrected the system (wrong data / I meant / switch).",
      evidence: evidenceId,
      rootCause: "Correction was not treated as a quality event.",
      impact: "User has to steer the product.",
    });
    failures.push("FOLLOW_UP_CONTEXT_FAILURE");
  }
  if (/try again|something went wrong|please retry|i(?:'| a)m having trouble/i.test(interaction.assistantAnswer ?? "")) {
    scores.RELIABILITY = Math.min(scores.RELIABILITY, 55);
    pushFinding(failures, findings, {
      category: "GENERIC_RETRY_AFTER_SUCCESS",
      expected: "No generic retry when the authorised path can still answer.",
      actual: "Generic retry / trouble copy was returned.",
      evidence: evidenceId,
      rootCause: "Failure collapsed to a generic retry.",
      impact: "User gets no business answer.",
    });
  }
  if (sequence.length >= 3) {
    const firstAssistant = sequence.find((turn) => turn.role === "assistant");
    if (firstAssistant && (firstAssistant.text?.length ?? 0) < 40 && requestedFamilies.size > 0) {
      scores.FIRST_ANSWER = Math.min(scores.FIRST_ANSWER, 75);
      pushFinding(failures, findings, {
        category: "FIRST_ANSWER_INCOMPLETE",
        expected: "First answer covers the requested authorised work.",
        actual: "First assistant turn was too thin to be useful.",
        evidence: evidenceId,
        rootCause: "Premature end of the first synthesis.",
        impact: "User had to follow up immediately.",
      });
    }
  }
  if (
    /how much|total|figure|£|invoice|sales|overdue/i.test(interaction.userMessage ?? "") &&
    interaction.assistantAnswer &&
    !/\d/.test(interaction.assistantAnswer) &&
    requestedFamilies.has("ACCOUNTING")
  ) {
    scores.FIRST_ANSWER = Math.min(scores.FIRST_ANSWER, 60);
    scores.COMPLETENESS = Math.min(scores.COMPLETENESS, 60);
    pushFinding(failures, findings, {
      category: "FIRST_ANSWER_INCOMPLETE",
      expected: "A figure ask returns the authorised numbers.",
      actual: "Answer contained no figures.",
      evidence: evidenceId,
      rootCause: "Missing figures on an accounting ask.",
      impact: "User cannot act on the answer.",
    });
  }
  if (interaction.evidenceRefs.some((ref) => ref.companyId && ref.companyId !== interaction.companyId)) {
    scores.RBAC = 0;
    pushFinding(failures, findings, {
      category: "CROSS_TENANT_RISK",
      expected: "Evidence stays inside the requesting tenant.",
      actual: "An evidence ref pointed at another companyId.",
      evidence: evidenceId,
      rootCause: "Tenant isolation missed a ref.",
      impact: "Cross-tenant leak risk.",
      severity: "CRITICAL",
    });
    failures.push("PERMISSION_LEAK");
  }

  const overall = Math.round(
    QUALITY_SCORE_DIMENSIONS.reduce((sum, key) => sum + scores[key], 0) / QUALITY_SCORE_DIMENSIONS.length,
  );
  const categories = uniqueCategories(failures);
  return {
    interactionId: interaction.interactionId,
    conversationId: interaction.conversationId,
    companyId: interaction.companyId,
    channel: interaction.channel,
    overallScore: overall,
    scores,
    failureCategories: categories,
    findings: ensureFindings(categories, findings, overall, evidenceId),
    severity: severityOf(categories, overall),
    notes: categories.length ? `Heuristic flags: ${categories.join(", ")}` : "No measurable defect.",
    evaluatorModel: "heuristic-v1",
    evaluatorKind: "heuristic",
    trafficClass: "QUALITY",
    customerChargeCents: 0,
    interactionTrafficClass: interaction.trafficClass,
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
  if (merged.overallScore < 95 && merged.findings.length === 0) {
    merged = {
      ...merged,
      findings: ensureFindings(merged.failureCategories, [], merged.overallScore, input.interaction.interactionId),
    };
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
      "Return STRICT JSON only. No prose.",
      "Schema:",
      '{ "quality_score": number, "dimension_scores": {INTENT,TOOL_SELECTION,EXACT_TOOL,RBAC,GROUNDING,FIRST_ANSWER,COMPLETENESS,MEMORY,FOLLOW_UP,NATURALNESS,EFFICIENCY,HALLUCINATION,RELIABILITY,USER_EFFORT}, "findings": [ { "category", "severity", "confidence", "expected_behavior", "actual_behavior", "evidence_reference", "root_cause_hypothesis", "user_impact" } ] }',
      "Do not accept a high-level paragraph instead of findings.",
      "If any dimension is below target, findings MUST be non-empty.",
      "Judge only against the user request, listed capabilities, permissions, tools executed, evidence refs, the final answer, and prior turns.",
      "Do not invent private system contents. Do not recommend weakening RBAC or rotating secrets.",
      `Allowed failure categories: ${FAILURE_CATEGORIES.join(", ")}`,
      "Allowed severities: CRITICAL, HIGH, MEDIUM, LOW.",
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
      heuristic: { scores: heuristic.scores, categories: heuristic.failureCategories, findings: heuristic.findings },
    }),
  });
  const structured = result.structured ?? extractScores(result.text);
  const scores = emptyScores(heuristic.overallScore);
  const dimensionScores = (structured.dimension_scores ?? structured.scores) as Record<string, unknown> | undefined;
  for (const key of QUALITY_SCORE_DIMENSIONS) {
    const value = Number(dimensionScores?.[key]);
    if (Number.isFinite(value)) scores[key] = clamp(value);
  }
  const rawFindings = Array.isArray(structured.findings) ? structured.findings : [];
  const findings = rawFindings
    .map((item) => parseFinding(item))
    .filter((item): item is QualityFinding => Boolean(item));
  const categories = uniqueCategories([
    ...heuristic.failureCategories,
    ...(((structured.categories as unknown[]) ?? [])
      .filter((item): item is FailureCategory => FAILURE_CATEGORIES.includes(item as FailureCategory))),
    ...findings.map((item) => item.category as FailureCategory).filter((item) => FAILURE_CATEGORIES.includes(item)),
  ]);
  const overall = Number(structured.quality_score ?? structured.overall);
  return {
    ...heuristic,
    scores,
    overallScore: Number.isFinite(overall)
      ? clamp(overall)
      : Math.round(QUALITY_SCORE_DIMENSIONS.reduce((sum, key) => sum + scores[key], 0) / QUALITY_SCORE_DIMENSIONS.length),
    failureCategories: categories,
    findings: findings.length ? findings : heuristic.findings,
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
    scores[key] = Math.round(heuristic.scores[key] * 0.4 + openai.scores[key] * 0.6);
  }
  const overall = Math.round(
    QUALITY_SCORE_DIMENSIONS.reduce((sum, key) => sum + scores[key], 0) / QUALITY_SCORE_DIMENSIONS.length,
  );
  const categories = uniqueCategories([...heuristic.failureCategories, ...openai.failureCategories]);
  return {
    ...openai,
    scores,
    overallScore: overall,
    failureCategories: categories,
    findings: mergeFindings([...(heuristic.findings ?? []), ...(openai.findings ?? [])]),
    severity: severityOf(categories, overall),
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

function parseFinding(raw: unknown): QualityFinding | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const category = String(row.category ?? "").trim();
  if (!category) return null;
  const severityRaw = String(row.severity ?? "MEDIUM").toUpperCase();
  const severity = (["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(severityRaw) ? severityRaw : "MEDIUM") as DailyImprovementSeverity;
  return {
    category,
    severity,
    confidence: clamp01(Number(row.confidence ?? 0.7)),
    expectedBehavior: String(row.expected_behavior ?? row.expectedBehavior ?? "").slice(0, 400),
    actualBehavior: String(row.actual_behavior ?? row.actualBehavior ?? "").slice(0, 400),
    evidenceReference: String(row.evidence_reference ?? row.evidenceReference ?? "turn").slice(0, 120),
    rootCauseHypothesis: String(row.root_cause_hypothesis ?? row.rootCauseHypothesis ?? "").slice(0, 400),
    userImpact: String(row.user_impact ?? row.userImpact ?? "").slice(0, 240),
  };
}

function pushFinding(
  failures: FailureCategory[],
  findings: QualityFinding[],
  input: {
    category: FailureCategory;
    expected: string;
    actual: string;
    evidence: string;
    rootCause: string;
    impact: string;
    severity?: DailyImprovementSeverity;
  },
): void {
  failures.push(input.category);
  findings.push({
    category: input.category,
    severity: input.severity ?? severityForCause(input.category, null),
    confidence: 0.8,
    expectedBehavior: input.expected,
    actualBehavior: input.actual,
    evidenceReference: input.evidence,
    rootCauseHypothesis: input.rootCause,
    userImpact: input.impact,
  });
}

export function ensureFindings(
  categories: FailureCategory[],
  existing: QualityFinding[],
  overall: number,
  evidence: string,
): QualityFinding[] {
  if (existing.length) return mergeFindings(existing);
  return categories
    .filter((category) => category !== "EXPECTED_PERMISSION_DENIAL")
    .map((category) => ({
      category,
      severity: severityForCause(category, overall),
      confidence: 0.7,
      expectedBehavior: "Correct authorised behaviour for this category.",
      actualBehavior: `Scored turn failed ${category} (quality ${overall}).`,
      evidenceReference: evidence,
      rootCauseHypothesis: "Dimension failed the agreed target.",
      userImpact: titleCase(category),
    }));
}

function mergeFindings(items: QualityFinding[]): QualityFinding[] {
  const seen = new Set<string>();
  const out: QualityFinding[] = [];
  for (const item of items) {
    const key = `${item.category}:${item.actualBehavior}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
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

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.7;
  return Math.max(0, Math.min(1, value));
}

function titleCase(value: string): string {
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase());
}

export function severityOf(categories: FailureCategory[], overall: number): DailyImprovementEvaluation["severity"] {
  if (categories.includes("CROSS_TENANT_RISK") || categories.includes("PERMISSION_LEAK")) return "CRITICAL";
  if (categories.includes("NO_FINAL_RESPONSE") || categories.includes("BILLING_ERROR") || categories.includes("HALLUCINATION")) {
    return "HIGH";
  }
  if (
    categories.includes("EMAIL_TO_XERO") ||
    categories.includes("MIXED_MULTI_TOOL") ||
    categories.includes("XERO_EXACT_TOOL_SELECTION") ||
    categories.includes("FALSE_PERMISSION_DENIAL") ||
    categories.includes("RBAC_RESPONSE_CONTRADICTION")
  ) {
    return "HIGH";
  }
  if (overall < 70) return "HIGH";
  if (categories.filter((item) => item !== "EXPECTED_PERMISSION_DENIAL").length && overall < 85) return "MEDIUM";
  if (categories.filter((item) => item !== "EXPECTED_PERMISSION_DENIAL").length) return "LOW";
  return null;
}

export function expectedToolForAsk(text: string): string | null {
  const capabilities = detectRequestedCapabilities(text);
  if (capabilities.length === 0) return null;
  return defaultToolForCapability(capabilities[0]);
}
