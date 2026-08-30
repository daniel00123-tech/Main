export const ACK_TARGET_MS = 1_500;
export const ACK_DECISION_MS = 800;
/** @deprecated Use ACK_DECISION_MS. Kept so existing imports keep compiling. */
export const ACK_AFTER_MS = ACK_DECISION_MS;
export const ACK_HARD_WARNING_MS = 3_000;
export const SIMPLE_CONVERSATION_TARGET_MS = 3_000;
export const SIMPLE_READ_TARGET_MS = 20_000;
export const MULTI_TOOL_TARGET_MS = 45_000;
export const PROGRESS_AFTER_MS = 12_000;
export const DELAY_NOTICE_MS = 30_000;
export const HARD_TIMEOUT_MS = 60_000;
export const HARD_SILENCE_MS = HARD_TIMEOUT_MS;
export const STUCK_INCIDENT_MS = 30_000;
export const SLOW_ACK_QUALITY_MS = 3_000;
export const SLOW_READ_QUALITY_MS = 30_000;
export const SLOW_TOTAL_QUALITY_MS = 60_000;

export const GREETING_TARGET_MS = 750;
export const FIRST_VISIBLE_TARGET_MS = 1_000;
export const FIRST_VISIBLE_HARD_MS = 2_000;
export const COALESCE_WINDOW_MS = 400;
export const TYPING_REFRESH_MS = 20_000;
export const TYPING_MAX_REFRESHES = 2;

export type WhatsAppLatencyMarks = {
  inboundReceivedAt?: number;
  webhookReceivedAt?: number;
  signatureVerifiedAt?: number;
  validatedAt?: number;
  queueAcceptedAt?: number;
  processingStartedAt: number;
  identityResolvedAt?: number;
  readSentAt?: number;
  typingSentAt?: number;
  intentClassifiedAt?: number;
  acknowledgementSentAt?: number;
  firstVisibleAt?: number;
  planningStartedAt?: number;
  planningCompletedAt?: number;
  toolStartedAt?: number;
  toolCompletedAt?: number;
  mcpStartedAt?: number;
  mcpCompletedAt?: number;
  knowledgeSearchStartedAt?: number;
  knowledgeSearchCompletedAt?: number;
  fetchStartedAt?: number;
  fetchCompletedAt?: number;
  synthesisStartedAt?: number;
  synthesisCompletedAt?: number;
  finalGeneratedAt?: number;
  finalSentAt?: number;
  outboundStartedAt?: number;
  outboundAcceptedAt?: number;
};

export type WhatsAppLatencyReport = {
  acknowledgementMs: number | null;
  firstVisibleMs: number | null;
  timeToFirstVisibleResponseMs: number | null;
  readMs: number | null;
  typingMs: number | null;
  queueMs: number | null;
  identityMs: number | null;
  planningMs: number | null;
  toolMs: number | null;
  mcpMs: number | null;
  knowledgeSearchMs: number | null;
  fetchMs: number | null;
  synthesisMs: number | null;
  generationMs: number | null;
  outboundMs: number | null;
  finalMs: number | null;
  totalMs: number;
  slowestStage: string | null;
};

export function createWhatsAppLatencyMarks(now = Date.now()): WhatsAppLatencyMarks {
  return { processingStartedAt: now };
}

export function summariseWhatsAppLatency(marks: WhatsAppLatencyMarks, now = Date.now()): WhatsAppLatencyReport {
  const start = marks.inboundReceivedAt ?? marks.webhookReceivedAt ?? marks.processingStartedAt;
  const firstVisible = marks.firstVisibleAt ?? marks.acknowledgementSentAt ?? marks.readSentAt;
  const report: WhatsAppLatencyReport = {
    acknowledgementMs:
      marks.acknowledgementSentAt != null ? marks.acknowledgementSentAt - start : null,
    firstVisibleMs: firstVisible != null ? firstVisible - start : null,
    timeToFirstVisibleResponseMs: firstVisible != null ? firstVisible - start : null,
    readMs: marks.readSentAt != null ? marks.readSentAt - start : null,
    typingMs: marks.typingSentAt != null ? marks.typingSentAt - start : null,
    queueMs:
      marks.queueAcceptedAt != null && marks.webhookReceivedAt != null
        ? marks.queueAcceptedAt - marks.webhookReceivedAt
        : null,
    identityMs:
      marks.identityResolvedAt != null ? marks.identityResolvedAt - (marks.validatedAt ?? marks.processingStartedAt) : null,
    planningMs:
      marks.planningStartedAt != null && marks.planningCompletedAt != null
        ? marks.planningCompletedAt - marks.planningStartedAt
        : marks.planningStartedAt != null && marks.intentClassifiedAt != null
          ? marks.planningStartedAt - marks.intentClassifiedAt
          : null,
    toolMs:
      marks.toolStartedAt != null && marks.toolCompletedAt != null
        ? marks.toolCompletedAt - marks.toolStartedAt
        : null,
    mcpMs:
      marks.mcpStartedAt != null && marks.mcpCompletedAt != null
        ? marks.mcpCompletedAt - marks.mcpStartedAt
        : null,
    knowledgeSearchMs:
      marks.knowledgeSearchStartedAt != null && marks.knowledgeSearchCompletedAt != null
        ? marks.knowledgeSearchCompletedAt - marks.knowledgeSearchStartedAt
        : null,
    fetchMs:
      marks.fetchStartedAt != null && marks.fetchCompletedAt != null
        ? marks.fetchCompletedAt - marks.fetchStartedAt
        : null,
    synthesisMs:
      marks.synthesisStartedAt != null && marks.synthesisCompletedAt != null
        ? marks.synthesisCompletedAt - marks.synthesisStartedAt
        : null,
    generationMs:
      marks.finalGeneratedAt != null && marks.toolCompletedAt != null
        ? marks.finalGeneratedAt - marks.toolCompletedAt
        : null,
    outboundMs:
      marks.outboundStartedAt != null && marks.outboundAcceptedAt != null
        ? marks.outboundAcceptedAt - marks.outboundStartedAt
        : null,
    finalMs: marks.finalSentAt != null ? marks.finalSentAt - start : null,
    totalMs: now - start,
    slowestStage: null,
  };
  const stages: Record<string, number | null> = {
    planning_ms: report.planningMs,
    queue_ms: report.queueMs,
    mcp_ms: report.mcpMs,
    knowledge_search_ms: report.knowledgeSearchMs,
    fetch_ms: report.fetchMs,
    synthesis_ms: report.synthesisMs,
    outbound_ms: report.outboundMs,
  };
  let slowest: string | null = null;
  let max = -1;
  for (const [key, value] of Object.entries(stages)) {
    if (value != null && value > max) {
      max = value;
      slowest = key;
    }
  }
  report.slowestStage = slowest;
  return report;
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
