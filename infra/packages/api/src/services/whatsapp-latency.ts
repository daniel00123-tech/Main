export const ACK_TARGET_MS = 2_000;
export const ACK_AFTER_MS = 3_000;
export const SIMPLE_CONVERSATION_TARGET_MS = 3_000;
export const SIMPLE_READ_TARGET_MS = 20_000;
export const MULTI_TOOL_TARGET_MS = 45_000;
export const HARD_SILENCE_MS = 55_000;
export const PROGRESS_AFTER_MS = 8_000;
export const SLOW_ACK_QUALITY_MS = 5_000;
export const SLOW_READ_QUALITY_MS = 30_000;
export const SLOW_TOTAL_QUALITY_MS = 60_000;

export type WhatsAppLatencyMarks = {
  webhookReceivedAt?: number;
  signatureVerifiedAt?: number;
  queueAcceptedAt?: number;
  processingStartedAt: number;
  identityResolvedAt?: number;
  intentClassifiedAt?: number;
  acknowledgementSentAt?: number;
  planningStartedAt?: number;
  toolStartedAt?: number;
  toolCompletedAt?: number;
  finalGeneratedAt?: number;
  outboundStartedAt?: number;
  outboundAcceptedAt?: number;
};

export type WhatsAppLatencyReport = {
  acknowledgementMs: number | null;
  queueMs: number | null;
  identityMs: number | null;
  planningMs: number | null;
  toolMs: number | null;
  generationMs: number | null;
  outboundMs: number | null;
  totalMs: number;
};

export function createWhatsAppLatencyMarks(now = Date.now()): WhatsAppLatencyMarks {
  return { processingStartedAt: now };
}

export function summariseWhatsAppLatency(marks: WhatsAppLatencyMarks, now = Date.now()): WhatsAppLatencyReport {
  const start = marks.webhookReceivedAt ?? marks.processingStartedAt;
  return {
    acknowledgementMs:
      marks.acknowledgementSentAt != null ? marks.acknowledgementSentAt - start : null,
    queueMs:
      marks.queueAcceptedAt != null && marks.webhookReceivedAt != null
        ? marks.queueAcceptedAt - marks.webhookReceivedAt
        : null,
    identityMs:
      marks.identityResolvedAt != null ? marks.identityResolvedAt - marks.processingStartedAt : null,
    planningMs:
      marks.planningStartedAt != null && marks.intentClassifiedAt != null
        ? marks.planningStartedAt - marks.intentClassifiedAt
        : null,
    toolMs:
      marks.toolStartedAt != null && marks.toolCompletedAt != null
        ? marks.toolCompletedAt - marks.toolStartedAt
        : null,
    generationMs:
      marks.finalGeneratedAt != null && marks.toolCompletedAt != null
        ? marks.finalGeneratedAt - marks.toolCompletedAt
        : null,
    outboundMs:
      marks.outboundStartedAt != null && marks.outboundAcceptedAt != null
        ? marks.outboundAcceptedAt - marks.outboundStartedAt
        : null,
    totalMs: now - start,
  };
}
