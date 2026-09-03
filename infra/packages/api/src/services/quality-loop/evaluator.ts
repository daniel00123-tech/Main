import { detectQualitySignals, type QualityAuditInput } from "../quality-auditor";
import { looksLikeRawToolDump } from "../whatsapp-compress";
import {
  QUALITY_DIMENSIONS,
  QUALITY_LOOP_CHANNEL,
  QUALITY_LOOP_EVALUATOR_VERSION,
  type ChannelEvaluator,
  type ConversationEvaluation,
  type ConversationThread,
  type DimensionScore,
  type QualityDimension,
  type QualityFlag,
  type QualityRuntimeConfig,
} from "./types";
import { CUSTOMER_PROGRESS_BUDGET_MS } from "./runtime-policy";

export function emptyDimensions(): Record<QualityDimension, DimensionScore> {
  return Object.fromEntries(QUALITY_DIMENSIONS.map((key) => [key, { score: 100, evidence: [] as string[] }])) as Record<
    QualityDimension,
    DimensionScore
  >;
}

export function threadFromAudit(input: {
  companyId: string;
  conversationKey: string;
  interactionId?: string | null;
  userId?: string | null;
  userMessages?: string[];
  assistantMessages?: string[];
  voiceTranscript?: string | null;
  buttonSelections?: string[];
  sourceUrls?: string[];
  audit: QualityAuditInput;
}): ConversationThread {
  const meta = input.audit.usage.map((row) => row.metadata ?? {}).find((row) => row.channel === "whatsapp") ?? {};
  const assistant = input.assistantMessages ?? [];
  const askedForSource = Boolean(meta.askedLink) || input.userMessages?.some((text) => /\b(link|url|source|download)\b/i.test(text));
  const permissionDenied = Boolean(meta.permissionDenied) || (input.audit.gateway ?? []).some((row) =>
    /permission|forbidden|unauthorized|denied|401|403/i.test(`${row.errorCode ?? ""} ${row.errorMessage ?? ""}`),
  );
  const permissionCorrect = permissionDenied && !meta.permissionShouldHaveSucceeded;
  return {
    companyId: input.companyId,
    conversationKey: input.conversationKey,
    interactionId: input.interactionId ?? input.audit.interactionId,
    userId: input.userId ?? input.audit.userId,
    channel: QUALITY_LOOP_CHANNEL,
    userMessages: input.userMessages ?? [],
    assistantMessages: assistant,
    acks: Number(meta.acknowledgementSent ? 1 : 0) + Number(meta.progressSent ? 1 : 0),
    progressUpdates: Number(meta.progressSent ? 1 : 0),
    buttonSelections: input.buttonSelections ?? (meta.inputKind === "button" ? [String(meta.buttonAction ?? "button")] : []),
    voiceTranscript: input.voiceTranscript ?? (typeof meta.transcript === "string" ? meta.transcript : null),
    toolNames: input.audit.usage.map((row) => row.toolName).filter((name): name is string => Boolean(name && name !== "whatsapp.send")),
    connectorErrors: (input.audit.gateway ?? [])
      .filter((row) => row.errorCode || (row.status && row.status !== "ok"))
      .map((row) => String(row.errorCode ?? row.errorMessage ?? "error")),
    sourceUrls: input.sourceUrls ?? (typeof meta.sourceUrl === "string" ? [meta.sourceUrl] : []),
    askedForSource: Boolean(askedForSource),
    followUp: Boolean(meta.followUp),
    contextLost: Boolean(meta.contextLost),
    rawLeak: Boolean(meta.rawLeak) || assistant.some((text) => looksLikeRawToolDump(text)),
    permissionDenied,
    permissionDenialCorrect: Boolean(permissionCorrect),
    acknowledgementMs: meta.acknowledgementMs != null ? Number(meta.acknowledgementMs) : null,
    firstVisibleMs: meta.firstVisibleMs != null ? Number(meta.firstVisibleMs) : Number(meta.acknowledgementMs ?? 0) || null,
    totalMs: meta.totalMs != null ? Number(meta.totalMs) : Number(input.audit.usage[0]?.durationMs ?? 0) || null,
    finalSent: Boolean(meta.finalSent ?? meta.success ?? assistant.length > 0),
    acknowledgementSent: Boolean(meta.acknowledgementSent),
    usageCostCents: input.audit.usage.reduce((sum, row) => sum + Number(row.customerChargeCents ?? 0), 0),
    qualitySignals: detectQualitySignals(input.audit).map((signal) => signal.category),
  };
}

export function evaluateWhatsAppConversation(
  thread: ConversationThread,
  runtime?: Pick<QualityRuntimeConfig, "thresholds">,
): ConversationEvaluation {
  const dimensions = emptyDimensions();
  const flags: QualityFlag[] = [];
  const firstVisibleLimit = runtime?.thresholds.ackWarningMs ?? 3_000;
  const slowTotalLimit = runtime?.thresholds.slowTotalMs ?? CUSTOMER_PROGRESS_BUDGET_MS;
  const evidence: Record<string, unknown> = {
    companyId: thread.companyId,
    conversationKey: thread.conversationKey,
    channel: thread.channel,
    evaluatorVersion: QUALITY_LOOP_EVALUATOR_VERSION,
    firstVisibleLimit,
    slowTotalLimit,
  };

  if (!thread.finalSent) {
    penalise(dimensions, "completeness", 40, "No final WhatsApp reply was recorded.");
    if ((thread.totalMs ?? 0) >= 30_000 || thread.qualitySignals.includes("whatsapp_silent")) {
      flags.push(neg("silence", "high", 0.95, "Recognised user had no user-visible final reply."));
    }
  } else if (thread.assistantMessages.length === 0) {
    dimensions.completeness.evidence.push("Final send recorded; reply body is only in authenticated Interaction detail.");
  }
  const greeting = thread.userMessages.some((text) => /^(hi+|hello+|hey+|thanks|morning|afternoon|evening)\b/i.test(text.trim()));
  if (greeting && (thread.firstVisibleMs ?? thread.totalMs ?? 0) >= 2_000) {
    penalise(dimensions, "latency", 25, "Greeting took more than 2 seconds.");
    flags.push(neg("greeting_slow", "high", 0.95, "Greeting exceeded the 2s WhatsApp UX budget."));
  }
  if (!thread.acknowledgementSent && (thread.firstVisibleMs ?? 0) >= firstVisibleLimit && thread.toolNames.length > 0) {
    penalise(dimensions, "ux", 20, "Slow tool turn had no typing or text acknowledgement.");
    flags.push(neg("no_ack_on_slow_turn", "high", 0.85, "No ack/typing on a slow recognised-user turn."));
  }
  if ((thread.firstVisibleMs ?? 0) >= firstVisibleLimit) {
    penalise(dimensions, "latency", 15, `First visible response exceeded ${Math.round(firstVisibleLimit / 1000)} seconds.`);
    flags.push(neg("first_visible_slow", "medium", 0.85, `First visible ${thread.firstVisibleMs}ms.`));
  }
  if (thread.qualitySignals.includes("whatsapp_rephrase_before_answer")) {
    penalise(dimensions, "ux", 20, "User rephrased or sent a second message before the first answer.");
    flags.push(neg("rephrase_before_answer", "high", 0.8, "Second message arrived before the first answer."));
  }
  if (thread.qualitySignals.includes("whatsapp_outbound_meta_failure") || thread.qualitySignals.includes("whatsapp_meta_unavailable")) {
    penalise(dimensions, "reliability", 25, "Meta outbound send failed.");
    flags.push(neg("outbound_meta_failure", "high", 0.9, "Outbound Meta send failed."));
  }
  if (thread.qualitySignals.includes("whatsapp_stuck") || ((thread.totalMs ?? 0) >= 60_000 && !thread.finalSent)) {
    penalise(dimensions, "reliability", 35, "Conversation stayed processing without a terminal reply.");
    flags.push(neg("stuck", "high", 0.9, "WhatsApp turn remained stuck."));
  }
  if (
    thread.qualitySignals.includes("whatsapp_no_final_after_ack") ||
    thread.qualitySignals.includes("whatsapp_ack_no_final_over_30s")
  ) {
    penalise(dimensions, "reliability", 30, "Acknowledgement was sent without a terminal reply.");
    flags.push(neg("ack_no_final", "high", 0.9, "Ack without final WhatsApp reply."));
  }
  if (thread.qualitySignals.includes("whatsapp_tool_timeout")) {
    penalise(dimensions, "reliability", 25, "Knowledge or tool call timed out.");
    flags.push(neg("tool_timeout", "high", 0.9, "Tool/MCP timeout."));
  }
  if (thread.qualitySignals.includes("whatsapp_broad_search_without_terms")) {
    penalise(dimensions, "tool_correctness", 15, "Broad document ask launched a search without usable terms.");
    flags.push(neg("broad_search", "medium", 0.8, "Broad search without distinctive terms."));
  }
  if (thread.qualitySignals.includes("whatsapp_user_wait_over_60s") || thread.qualitySignals.includes("whatsapp_final_over_60s")) {
    flags.push(neg("user_wait_over_60s", "high", 0.85, `User wait ${thread.totalMs}ms.`));
  }
  if (thread.contextLost || thread.qualitySignals.includes("whatsapp_context_lost") || thread.qualitySignals.includes("whatsapp_button_context_lost")) {
    penalise(dimensions, "context", 35, "Follow-up could not reuse the previous entity.");
    flags.push(neg("context_loss", "high", 0.8, "Context was lost on a follow-up or button tap."));
  }
  if (thread.rawLeak || thread.qualitySignals.includes("whatsapp_raw_output")) {
    penalise(dimensions, "grounding", 40, "Raw tool or document output leaked into the reply.");
    flags.push(neg("raw_dump", "high", 0.95, "Reply contained a raw dump."));
  }
  if (thread.askedForSource && thread.sourceUrls.length === 0) {
    penalise(dimensions, "grounding", 25, "User asked for a source link and none was returned.");
    flags.push(neg("missing_source_url", "medium", 0.85, "Missing source URL after an explicit ask."));
  }
  const latency = thread.totalMs ?? thread.firstVisibleMs ?? 0;
  if (latency >= Math.min(30_000, slowTotalLimit)) {
    penalise(dimensions, "latency", latency >= CUSTOMER_PROGRESS_BUDGET_MS ? 35 : 20, `Turn took ${latency}ms.`);
    flags.push(neg("excessive_latency", latency >= CUSTOMER_PROGRESS_BUDGET_MS ? "high" : "medium", 0.85, `Latency ${latency}ms.`));
  }
  if (thread.qualitySignals.includes("whatsapp_unnecessary_tool") || thread.qualitySignals.includes("whatsapp_wrong_tool")) {
    penalise(dimensions, "tool_correctness", 20, "Planner used the wrong or an unnecessary tool.");
    flags.push(neg("wrong_tool", "medium", 0.75, "Wrong or unnecessary tool call."));
  }
  if (thread.permissionDenied) {
    if (thread.permissionDenialCorrect) {
      flags.push(pos("permission_denial_correct", "low", 0.95, "Permission denial was a correct policy outcome, not a model failure."));
      boost(dimensions, "permission_safety", 5, "Correct permission denial.");
    } else {
      penalise(dimensions, "permission_safety", 15, "Permission UX failed or denial looks unexpected.");
      flags.push(neg("permission_ux", "medium", 0.7, "Permission denial needs operator review."));
    }
  }
  const lastUser = thread.userMessages[thread.userMessages.length - 1] ?? "";
  const rephrase = thread.qualitySignals.includes("repeated_user_rephrase") || looksLikeRephrase(thread);
  if (rephrase) {
    penalise(dimensions, "ux", 15, "User immediately rephrased after a prior turn.");
    flags.push(neg("rephrase", "medium", 0.6, "User rephrased shortly after the previous answer."));
  }
  if (thread.acks >= 3) {
    penalise(dimensions, "ux", 10, "Repeated acknowledgements before a useful answer.");
    flags.push(neg("repeated_acks", "low", 0.7, `${thread.acks} acknowledgements/progress messages.`));
  }
  if (thread.qualitySignals.includes("whatsapp_voice_no_response") || thread.qualitySignals.includes("whatsapp_transcription_failed")) {
    penalise(dimensions, "reliability", 25, "Voice note failed to produce a reply.");
    flags.push(neg("voice_failure", "high", 0.85, "Voice transcription or reply failed."));
  }
  if (thread.connectorErrors.length > 0 && !thread.permissionDenied) {
    penalise(dimensions, "reliability", 15, "Connector or gateway error.");
    flags.push(neg("connector_error", "medium", 0.8, thread.connectorErrors[0] ?? "connector error"));
  }
  if (thread.qualitySignals.includes("whatsapp_current_document_global_search")) {
    penalise(dimensions, "tool_correctness", 30, "Current-document question triggered global search.");
    flags.push(neg("current_document_global_search", "high", 0.9, "Current-document question used company-wide search."));
  }
  if (thread.qualitySignals.includes("whatsapp_unrelated_document_after_context")) {
    penalise(dimensions, "context", 30, "Contextual question returned an unrelated document.");
    flags.push(neg("unrelated_document_after_context", "high", 0.85, "Unrelated document after a current-document question."));
  }
  if (thread.qualitySignals.includes("whatsapp_answer_repeated_excerpt")) {
    penalise(dimensions, "grounding", 20, "Answer repeated the original excerpt.");
    flags.push(neg("answer_repeated_excerpt", "medium", 0.8, "Answer restated the search preview."));
  }
  if (thread.qualitySignals.includes("whatsapp_more_detail_identical")) {
    penalise(dimensions, "completeness", 25, "More detail did not add information.");
    flags.push(neg("more_detail_identical", "high", 0.85, "More detail matched the original excerpt."));
  }
  if (thread.qualitySignals.includes("whatsapp_malformed_extraction")) {
    penalise(dimensions, "grounding", 20, "Type-inappropriate extraction.");
    flags.push(neg("malformed_extraction", "medium", 0.8, "Invoice facts extracted from a non-invoice document."));
  }
  if (thread.qualitySignals.includes("whatsapp_unsolicited_pii")) {
    penalise(dimensions, "permission_safety", 25, "Unsolicited contact details from a CV.");
    flags.push(neg("unsolicited_pii", "high", 0.9, "Phone or email surfaced without an explicit request."));
  }
  if (thread.qualitySignals.includes("whatsapp_weak_result_confident")) {
    penalise(dimensions, "grounding", 20, "Weak search result presented confidently.");
    flags.push(neg("weak_result_confident", "medium", 0.75, "Low-confidence hit shown as a confident answer."));
  }
  if (thread.qualitySignals.includes("whatsapp_negative_result_feedback")) {
    penalise(dimensions, "ux", 20, "User rejected the preceding answer.");
    flags.push(neg("negative_result_feedback", "high", 0.9, "Explicit negative feedback on the previous Infra answer."));
  }
  if (thread.qualitySignals.includes("whatsapp_topic_correction")) {
    penalise(dimensions, "context", 20, "User corrected the topic.");
    flags.push(neg("topic_correction", "high", 0.85, "User said the previous answer was the wrong topic."));
  }

  if (/\b(thanks|thank you|cheers|perfect|great)\b/i.test(lastUser)) {
    flags.push(pos("thanks", "low", 0.55, "User thanked Infra. Missing thanks is not treated as failure."));
    boost(dimensions, "ux", 5, "User expressed thanks.");
  }
  if (thread.followUp && !thread.contextLost && thread.finalSent) {
    flags.push(pos("follow_up_used", "low", 0.8, "Follow-up reused conversation memory."));
    boost(dimensions, "context", 5, "Follow-up used prior context.");
  }
  if (thread.toolNames.length === 1 && thread.finalSent && !thread.qualitySignals.includes("whatsapp_wrong_tool")) {
    flags.push(pos("first_tool_correct", "low", 0.6, "First tool appears sufficient."));
    boost(dimensions, "tool_correctness", 5, "First-tool-correct.");
  }
  if ((thread.totalMs ?? 99_000) > 0 && (thread.totalMs ?? 99_000) <= 8_000 && thread.finalSent) {
    flags.push(pos("fast_response", "low", 0.7, "Final reply arrived quickly."));
    boost(dimensions, "latency", 5, "Fast final reply.");
  }

  const negatives = flags.filter((flag) => flag.polarity === "negative");
  const failed = negatives.some((flag) => flag.severity === "high") || overall(dimensions) < 70;
  const confidence = Math.max(0.45, Math.min(0.95, 0.7 + (thread.assistantMessages.length > 0 ? 0.1 : 0) - (rephrase ? 0.05 : 0)));

  return {
    companyId: thread.companyId,
    conversationKey: thread.conversationKey,
    interactionId: thread.interactionId,
    channel: thread.channel,
    dimensions,
    overallQualityScore: overall(dimensions),
    confidence,
    evaluatorVersion: QUALITY_LOOP_EVALUATOR_VERSION,
    flags,
    failed,
    permissionDenialCorrect: Boolean(thread.permissionDenialCorrect && thread.permissionDenied),
    evidence,
  };
}

export const whatsappEvaluator: ChannelEvaluator = {
  channel: "whatsapp",
  evaluate: evaluateWhatsAppConversation,
};

export function resolveChannelEvaluator(channel: ConversationThread["channel"]): ChannelEvaluator | null {
  if (channel === "whatsapp") return whatsappEvaluator;
  return null;
}

function looksLikeRephrase(thread: ConversationThread): boolean {
  if (thread.userMessages.length < 2) return false;
  const a = normalize(thread.userMessages[thread.userMessages.length - 2] ?? "");
  const b = normalize(thread.userMessages[thread.userMessages.length - 1] ?? "");
  if (!a || !b || a === b) return a === b && a.length > 0;
  const overlap = jaccard(a, b);
  return overlap >= 0.45;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function jaccard(a: string, b: string): number {
  const left = new Set(a.split(" ").filter(Boolean));
  const right = new Set(b.split(" ").filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;
  let inter = 0;
  for (const word of left) if (right.has(word)) inter += 1;
  return inter / new Set([...left, ...right]).size;
}

function penalise(dimensions: Record<QualityDimension, DimensionScore>, key: QualityDimension, amount: number, evidence: string) {
  dimensions[key].score = Math.max(0, dimensions[key].score - amount);
  dimensions[key].evidence.push(evidence);
}

function boost(dimensions: Record<QualityDimension, DimensionScore>, key: QualityDimension, amount: number, evidence: string) {
  dimensions[key].score = Math.min(100, dimensions[key].score + amount);
  dimensions[key].evidence.push(evidence);
}

function overall(dimensions: Record<QualityDimension, DimensionScore>): number {
  const values = QUALITY_DIMENSIONS.map((key) => dimensions[key].score);
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function neg(category: QualityFlag["category"], severity: QualityFlag["severity"], confidence: number, evidence: string): QualityFlag {
  return { category, polarity: "negative", severity, confidence, evidence };
}

function pos(category: QualityFlag["category"], severity: QualityFlag["severity"], confidence: number, evidence: string): QualityFlag {
  return { category, polarity: "positive", severity, confidence, evidence };
}

export function assertTenantIsolation(evaluations: ConversationEvaluation[]): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  for (const evaluation of evaluations) {
    if (!evaluation.companyId) violations.push(`${evaluation.conversationKey}: missing companyId`);
    if (evaluation.evidence.companyId && evaluation.evidence.companyId !== evaluation.companyId) {
      violations.push(`${evaluation.conversationKey}: mixed company context`);
    }
  }
  return { ok: violations.length === 0, violations };
}
