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
    acknowledgedAt?: string;
    planningAt?: string;
    toolRunningAt?: string;
    synthesisingAt?: string;
    replySentAt?: string;
    firstVisibleAt?: string;
    lastError?: string | null;
  },
): Promise<void> {
  if (!wamid) return;
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.state) {
    sets.push("lifecycle_state = ?");
    values.push(patch.state);
  }
  if (patch.terminal) {
    sets.push("terminal_state = ?");
    values.push(patch.terminal);
  }
  if (patch.validatedAt) {
    sets.push("validated_at = COALESCE(validated_at, ?)");
    values.push(patch.validatedAt);
  }
  if (patch.acknowledgedAt) {
    sets.push("acknowledged_at = COALESCE(acknowledged_at, ?)");
    values.push(patch.acknowledgedAt);
  }
  if (patch.planningAt) {
    sets.push("planning_at = COALESCE(planning_at, ?)");
    values.push(patch.planningAt);
  }
  if (patch.toolRunningAt) {
    sets.push("tool_running_at = COALESCE(tool_running_at, ?)");
    values.push(patch.toolRunningAt);
  }
  if (patch.synthesisingAt) {
    sets.push("synthesising_at = COALESCE(synthesising_at, ?)");
    values.push(patch.synthesisingAt);
  }
  if (patch.replySentAt) {
    sets.push("reply_sent_at = COALESCE(reply_sent_at, ?)");
    values.push(patch.replySentAt);
  }
  if (patch.firstVisibleAt) {
    sets.push("first_visible_at = COALESCE(first_visible_at, ?)");
    values.push(patch.firstVisibleAt);
  }
  if (patch.lastError !== undefined) {
    sets.push("last_error = ?");
    values.push(patch.lastError);
  }
  if (!sets.length) return;
  values.push(wamid);
  try {
    await env.DB.prepare(
      `UPDATE whatsapp_inbound_events SET ${sets.join(", ")} WHERE wamid = ?`,
    )
      .bind(...values)
      .run();
  } catch {
    // Lifecycle columns are added at runtime; never fail the user path.
  }
}
