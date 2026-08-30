import type { Env } from "../env";

export const WHATSAPP_LIFECYCLE_STATES = [
  "received",
  "validated",
  "acknowledged",
  "planning",
  "tool_running",
  "synthesising",
  "reply_sent",
  "clarification_sent",
  "permission_denied",
  "no_result",
  "failed_notified",
] as const;

export type WhatsAppLifecycleState = (typeof WHATSAPP_LIFECYCLE_STATES)[number];

export const WHATSAPP_TERMINAL_STATES = [
  "reply_sent",
  "clarification_sent",
  "permission_denied",
  "no_result",
  "failed_notified",
] as const;

export type WhatsAppTerminalState = (typeof WHATSAPP_TERMINAL_STATES)[number];

export function isWhatsAppTerminalState(state: string | null | undefined): boolean {
  return WHATSAPP_TERMINAL_STATES.includes(state as WhatsAppTerminalState);
}

export function terminalStateForOutcome(input: {
  outcome: string;
  planAction?: string | null;
  reply?: string | null;
}): WhatsAppTerminalState {
  if (input.planAction === "clarify" || input.outcome === "clarification_requested") {
    return "clarification_sent";
  }
  if (input.outcome === "write_blocked" || /permission/i.test(input.reply ?? "")) {
    if (input.outcome === "write_blocked") return "permission_denied";
  }
  if (input.outcome === "tool_failed" && /permission/i.test(input.reply ?? "")) {
    return "permission_denied";
  }
  if (input.outcome === "answered" && /couldn’t find that/i.test(input.reply ?? "")) {
    return "no_result";
  }
  if (
    input.outcome === "ai_failed" ||
    input.outcome === "tool_failed" ||
    input.outcome === "send_failed"
  ) {
    return "failed_notified";
  }
  return "reply_sent";
}

export async function stampWhatsAppLifecycle(
  env: Env,
  wamid: string | null | undefined,
  patch: {
    state?: WhatsAppLifecycleState;
    terminal?: WhatsAppTerminalState | null;
    validatedAt?: string;
    identityResolvedAt?: string;
    acknowledgedAt?: string;
    planningAt?: string;
    toolRunningAt?: string;
    synthesisingAt?: string;
    replySentAt?: string;
    firstVisibleAt?: string;
    readStatusSentAt?: string;
    typingSentAt?: string;
    acknowledgementSentAt?: string;
    finalSentAt?: string;
    recoverSentAt?: string;
    queueAcceptedAt?: string;
    timeToFirstVisibleMs?: number | null;
    readStatusOk?: number;
    typingOk?: number;
    ackSendOk?: number;
    finalSendOk?: number;
    outboundError?: string | null;
    lastError?: string | null;
    outboundHttpStatus?: number | null;
    outboundMetaMessageId?: string | null;
    outboundAttempts?: number | null;
    persistOk?: number;
    persistError?: string | null;
    webhookStatus?: number | null;
    fastLane?: number;
    watchdog10sAt?: string;
    watchdog30sAt?: string;
    dlqAt?: string;
    senderE164?: string | null;
    inboundText?: string | null;
    identityFound?: number;
    userId?: string | null;
    companyId?: string | null;
  },
): Promise<void> {
  if (!wamid) return;
  const sets: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    sets.push(sql);
    values.push(value);
  };
  if (patch.state) add("lifecycle_state = ?", patch.state);
  if (patch.terminal) add("terminal_state = ?", patch.terminal);
  if (patch.validatedAt) add("validated_at = COALESCE(validated_at, ?)", patch.validatedAt);
  if (patch.identityResolvedAt) add("identity_resolved_at = COALESCE(identity_resolved_at, ?)", patch.identityResolvedAt);
  if (patch.acknowledgedAt) add("acknowledged_at = COALESCE(acknowledged_at, ?)", patch.acknowledgedAt);
  if (patch.planningAt) add("planning_at = COALESCE(planning_at, ?)", patch.planningAt);
  if (patch.toolRunningAt) add("tool_running_at = COALESCE(tool_running_at, ?)", patch.toolRunningAt);
  if (patch.synthesisingAt) add("synthesising_at = COALESCE(synthesising_at, ?)", patch.synthesisingAt);
  if (patch.replySentAt) add("reply_sent_at = COALESCE(reply_sent_at, ?)", patch.replySentAt);
  if (patch.firstVisibleAt) add("first_visible_at = COALESCE(first_visible_at, ?)", patch.firstVisibleAt);
  if (patch.readStatusSentAt) add("read_status_sent_at = COALESCE(read_status_sent_at, ?)", patch.readStatusSentAt);
  if (patch.typingSentAt) add("typing_sent_at = COALESCE(typing_sent_at, ?)", patch.typingSentAt);
  if (patch.acknowledgementSentAt) {
    add("acknowledgement_sent_at = COALESCE(acknowledgement_sent_at, ?)", patch.acknowledgementSentAt);
  }
  if (patch.finalSentAt) add("final_sent_at = COALESCE(final_sent_at, ?)", patch.finalSentAt);
  if (patch.recoverSentAt) add("recover_sent_at = COALESCE(recover_sent_at, ?)", patch.recoverSentAt);
  if (patch.queueAcceptedAt) add("queue_accepted_at = COALESCE(queue_accepted_at, ?)", patch.queueAcceptedAt);
  if (patch.timeToFirstVisibleMs != null) {
    add("time_to_first_visible_ms = COALESCE(time_to_first_visible_ms, ?)", patch.timeToFirstVisibleMs);
  }
  if (patch.readStatusOk != null) add("read_status_ok = ?", patch.readStatusOk);
  if (patch.typingOk != null) add("typing_ok = ?", patch.typingOk);
  if (patch.ackSendOk != null) add("ack_send_ok = ?", patch.ackSendOk);
  if (patch.finalSendOk != null) add("final_send_ok = ?", patch.finalSendOk);
  if (patch.outboundError !== undefined) add("outbound_error = ?", patch.outboundError);
  if (patch.lastError !== undefined) add("last_error = ?", patch.lastError);
  if (patch.outboundHttpStatus !== undefined) add("outbound_http_status = ?", patch.outboundHttpStatus);
  if (patch.outboundMetaMessageId !== undefined) add("outbound_meta_message_id = ?", patch.outboundMetaMessageId);
  if (patch.outboundAttempts !== undefined) add("outbound_attempts = ?", patch.outboundAttempts);
  if (patch.persistOk != null) add("persist_ok = ?", patch.persistOk);
  if (patch.persistError !== undefined) add("persist_error = ?", patch.persistError);
  if (patch.webhookStatus !== undefined) add("webhook_status = ?", patch.webhookStatus);
  if (patch.fastLane != null) add("fast_lane = ?", patch.fastLane);
  if (patch.watchdog10sAt) add("watchdog_10s_at = COALESCE(watchdog_10s_at, ?)", patch.watchdog10sAt);
  if (patch.watchdog30sAt) add("watchdog_30s_at = COALESCE(watchdog_30s_at, ?)", patch.watchdog30sAt);
  if (patch.dlqAt) add("dlq_at = COALESCE(dlq_at, ?)", patch.dlqAt);
  if (patch.senderE164) add("sender_e164 = COALESCE(sender_e164, ?)", patch.senderE164);
  if (patch.inboundText) add("inbound_text = COALESCE(inbound_text, ?)", patch.inboundText.slice(0, 500));
  if (patch.identityFound != null) add("identity_found = ?", patch.identityFound);
  if (patch.userId) add("user_id = COALESCE(user_id, ?)", patch.userId);
  if (patch.companyId) add("company_id = COALESCE(company_id, ?)", patch.companyId);
  if (!sets.length) return;
  values.push(wamid);
  try {
    await env.DB.prepare(`UPDATE whatsapp_inbound_events SET ${sets.join(", ")} WHERE wamid = ?`)
      .bind(...values)
      .run();
  } catch {
    // Lifecycle columns are added at runtime; never fail the user path.
  }
}
