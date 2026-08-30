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
} from "./types";

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

export function evaluateWhatsAppConversation(thread: ConversationThread): ConversationEvaluation {
  const dimensions = emptyDimensions();
  const flags: QualityFlag[] = [];
  const evidence: Record<string, unknown> = {
    companyId: thread.companyId,
    conversationKey: thread.conversationKey,
    channel: thread.channel,
    evaluatorVersion: QUALITY_LOOP_EVALUATOR_VERSION,
  };

  if (!thread.finalSent || thread.assistantMessages.length === 0) {
    penalise(dimensions, "completeness", 40, "No final WhatsApp reply was recorded.");
    if ((thread.totalMs ?? 0) >= 30_000 || thread.qualitySignals.includes("whatsapp_silent")) {
      flags.push(neg("silence", "high", 0.95, "Recognised user had no user-visible final reply."));
    }
  }
  if (thread.qualitySignals.includes("whatsapp_stuck") || ((thread.totalMs ?? 0) >= 60_000 && !thread.finalSent)) {
    penalise(dimensions, "reliability", 35, "Conversation stayed processing without a terminal reply.");
    flags.push(neg("stuck", "high", 0.9, "WhatsApp turn remained stuck."));
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
  if (latency >= 30_000) {
    penalise(dimensions, "latency", latency >= 60_000 ? 35 : 20, `Turn took ${latency}ms.`);
    flags.push(neg("excessive_latency", latency >= 60_000 ? "high" : "medium", 0.85, `Latency ${latency}ms.`));
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
