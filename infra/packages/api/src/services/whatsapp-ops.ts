import { nowIso } from "../db/mappers";
import type { Env } from "../env";
import { isWhatsAppTerminalState } from "./whatsapp-lifecycle";
import { STUCK_INCIDENT_MS } from "./whatsapp-latency";
import { listOpenKnowledgeCircuits } from "./whatsapp-knowledge-breaker";
import { ensureWhatsAppInboundTable } from "./whatsapp-webhook";

export type WhatsAppInboxRow = {
  id: string;
  wamid: string | null;
  companyId: string | null;
  userId: string | null;
  lifecycleState: string;
  terminalState: string | null;
  receivedAt: string;
  firstVisibleAt: string | null;
  replySentAt: string | null;
  lastError: string | null;
  processed: number;
  ageMs: number;
  stuck: boolean;
  status: "received" | "processing" | "stuck" | "failed" | "replied";
};

function classifyInboxRow(row: {
  processed: number;
  lifecycle_state: string | null;
  terminal_state: string | null;
  first_visible_at: string | null;
  reply_sent_at: string | null;
  last_error: string | null;
  error: string | null;
  received_at: string;
}): { status: WhatsAppInboxRow["status"]; stuck: boolean; ageMs: number } {
  const ageMs = Math.max(0, Date.now() - Date.parse(row.received_at));
  const terminal = row.terminal_state || (row.processed === 1 ? row.lifecycle_state : null);
  const visible = Boolean(row.first_visible_at || row.reply_sent_at);
  const failed = Boolean(row.last_error || row.error) && isWhatsAppTerminalState(terminal) && /fail/i.test(terminal ?? "");
  const ackWithoutFinal = visible && !row.reply_sent_at && !isWhatsAppTerminalState(terminal);
  const stuck =
    !isWhatsAppTerminalState(terminal) &&
    ((!visible && ageMs >= STUCK_INCIDENT_MS) || (ackWithoutFinal && ageMs >= 30_000));
  if (stuck) return { status: "stuck", stuck: true, ageMs };
  if (failed || terminal === "failed_notified") return { status: "failed", stuck: false, ageMs };
  if (isWhatsAppTerminalState(terminal) || row.reply_sent_at) return { status: "replied", stuck: false, ageMs };
  if (row.processed === 0 && /PROCESSING|planning|tool_running|acknowledged/i.test(`${row.error ?? ""} ${row.lifecycle_state ?? ""}`)) {
    return { status: "processing", stuck: false, ageMs };
  }
  return { status: "received", stuck: false, ageMs };
}

export async function listWhatsAppInbox(
  env: Env,
  options?: { limit?: number },
): Promise<{
  items: WhatsAppInboxRow[];
  stuckCount: number;
  processingCount: number;
  failedCount: number;
  consecutiveFailedReplies: number;
}> {
  await ensureWhatsAppInboundTable(env);
  const limit = Math.min(200, Math.max(1, options?.limit ?? 80));
  let rows: Array<Record<string, unknown>> = [];
  try {
    const result = await env.DB.prepare(
      `SELECT id, wamid, company_id, user_id, lifecycle_state, terminal_state,
              received_at, first_visible_at, reply_sent_at, last_error, error, processed
       FROM whatsapp_inbound_events
       ORDER BY received_at DESC
       LIMIT ?`,
    )
      .bind(limit)
      .all();
    rows = (result.results ?? []) as Array<Record<string, unknown>>;
  } catch {
    const result = await env.DB.prepare(
      `SELECT id, wamid, company_id, user_id, received_at, error, processed
       FROM whatsapp_inbound_events
       ORDER BY received_at DESC
       LIMIT ?`,
    )
      .bind(limit)
      .all();
    rows = (result.results ?? []) as Array<Record<string, unknown>>;
  }

  const items = rows.map((row) => {
    const classified = classifyInboxRow({
      processed: Number(row.processed ?? 0),
      lifecycle_state: row.lifecycle_state ? String(row.lifecycle_state) : null,
      terminal_state: row.terminal_state ? String(row.terminal_state) : null,
      first_visible_at: row.first_visible_at ? String(row.first_visible_at) : null,
      reply_sent_at: row.reply_sent_at ? String(row.reply_sent_at) : null,
      last_error: row.last_error ? String(row.last_error) : null,
      error: row.error ? String(row.error) : null,
      received_at: String(row.received_at ?? nowIso()),
    });
    return {
      id: String(row.id),
      wamid: row.wamid ? String(row.wamid) : null,
      companyId: row.company_id ? String(row.company_id) : null,
      userId: row.user_id ? String(row.user_id) : null,
      lifecycleState: String(row.lifecycle_state ?? (Number(row.processed) === 1 ? "reply_sent" : "received")),
      terminalState: row.terminal_state ? String(row.terminal_state) : null,
      receivedAt: String(row.received_at ?? ""),
      firstVisibleAt: row.first_visible_at ? String(row.first_visible_at) : null,
      replySentAt: row.reply_sent_at ? String(row.reply_sent_at) : null,
      lastError: row.last_error ? String(row.last_error) : row.error ? String(row.error) : null,
      processed: Number(row.processed ?? 0),
      ageMs: classified.ageMs,
      stuck: classified.stuck,
      status: classified.status,
    };
  });

  const recentFailed = items.filter((item) => item.status === "failed").slice(0, 3);
  const metrics = await computeWhatsAppUxMetrics(env).catch(() => emptyWhatsAppUxMetrics());
  return {
    items,
    stuckCount: items.filter((item) => item.stuck).length,
    processingCount: items.filter((item) => item.status === "processing").length,
    failedCount: items.filter((item) => item.status === "failed").length,
    consecutiveFailedReplies: recentFailed.length === 3 ? 3 : 0,
    metrics,
  };
}

export type WhatsAppUxMetrics = {
  recognisedMessages: number;
  firstVisibleP50Ms: number | null;
  firstVisibleP95Ms: number | null;
  finalP50Ms: number | null;
  finalP95Ms: number | null;
  silentOver3s: number;
  silentOver10s: number;
  stuckOver30s: number;
  failedOutbound: number;
  queueLatencyP50Ms: number | null;
  typingSuccessRate: number | null;
  readStatusSuccessRate: number | null;
  greetingSilentOver3s: number;
  queueOldestMs: number | null;
  dlqEvents: number;
  signatureRejects: number;
  liveMetaInbound: number;
  persistFailures: number;
  ackWithoutFinalOver30s: number;
  knowledgeCircuitOpen: number;
  healthState: "GREEN" | "AMBER" | "RED";
  redReasons: string[];
};

function emptyWhatsAppUxMetrics(): WhatsAppUxMetrics {
  return {
    recognisedMessages: 0,
    firstVisibleP50Ms: null,
    firstVisibleP95Ms: null,
    finalP50Ms: null,
    finalP95Ms: null,
    silentOver3s: 0,
    silentOver10s: 0,
    stuckOver30s: 0,
    failedOutbound: 0,
    queueLatencyP50Ms: null,
    typingSuccessRate: null,
    readStatusSuccessRate: null,
    greetingSilentOver3s: 0,
    queueOldestMs: null,
    dlqEvents: 0,
    signatureRejects: 0,
    liveMetaInbound: 0,
    persistFailures: 0,
    ackWithoutFinalOver30s: 0,
    knowledgeCircuitOpen: 0,
    healthState: "AMBER",
    redReasons: [],
  };
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

export async function computeWhatsAppUxMetrics(env: Env): Promise<WhatsAppUxMetrics> {
  await ensureWhatsAppInboundTable(env);
  let rows: Array<Record<string, unknown>> = [];
  try {
    const result = await env.DB.prepare(
      `SELECT identity_found, received_at, first_visible_at, reply_sent_at, final_sent_at,
              time_to_first_visible_ms, queue_accepted_at, typing_ok, read_status_ok,
              final_send_ok, terminal_state, last_error, inbound_text, wamid, processed,
              error, persist_ok, persist_error, signature_error, webhook_status, dlq_at
       FROM whatsapp_inbound_events
       WHERE received_at >= datetime('now', '-7 days')
       ORDER BY received_at DESC
       LIMIT 400`,
    ).all();
    rows = (result.results ?? []) as Array<Record<string, unknown>>;
  } catch {
    return emptyWhatsAppUxMetrics();
  }
  const recognised = rows.filter((row) => Number(row.identity_found) === 1);
  const firstVisible: number[] = [];
  const finals: number[] = [];
  const queue: number[] = [];
  let silent3 = 0;
  let silent10 = 0;
  let stuck30 = 0;
  let failedOutbound = 0;
  let typingOk = 0;
  let typingN = 0;
  let readOk = 0;
  let readN = 0;
  for (const row of recognised) {
    const received = Date.parse(String(row.received_at ?? ""));
    const visibleAt = row.first_visible_at || row.reply_sent_at;
    const finalAt = row.final_sent_at || row.reply_sent_at;
    const stored = row.time_to_first_visible_ms != null ? Number(row.time_to_first_visible_ms) : null;
    const firstMs =
      stored ??
      (visibleAt && Number.isFinite(received) ? Date.parse(String(visibleAt)) - received : null);
    if (firstMs != null && Number.isFinite(firstMs) && firstMs >= 0) firstVisible.push(firstMs);
    if (finalAt && Number.isFinite(received)) {
      const finalMs = Date.parse(String(finalAt)) - received;
      if (Number.isFinite(finalMs) && finalMs >= 0) finals.push(finalMs);
    }
    if (row.queue_accepted_at && Number.isFinite(received)) {
      const q = Date.parse(String(row.queue_accepted_at)) - received;
      if (Number.isFinite(q) && q >= 0) queue.push(q);
    }
    const age = Number.isFinite(received) ? Date.now() - received : 0;
    const visible = Boolean(visibleAt);
    if (!visible && age >= 3_000) silent3 += 1;
    if (!visible && age >= 10_000) silent10 += 1;
    const terminal = row.terminal_state ? String(row.terminal_state) : null;
    if (
      !isWhatsAppTerminalState(terminal) &&
      age >= 30_000 &&
      (!visible || (!row.reply_sent_at && !row.final_sent_at))
    ) {
      stuck30 += 1;
    }
    if (Number(row.final_send_ok) === 0 || /send_failed|outbound/i.test(String(row.last_error ?? ""))) {
      failedOutbound += 1;
    }
    if (row.typing_ok != null) {
      typingN += 1;
      if (Number(row.typing_ok) === 1) typingOk += 1;
    }
    if (row.read_status_ok != null) {
      readN += 1;
      if (Number(row.read_status_ok) === 1) readOk += 1;
    }
  }
  const recentCutoff = Date.now() - 15 * 60_000;
  let greetingSilentOver3s = 0;
  let queueOldestMs: number | null = null;
  let dlqEvents = 0;
  let signatureRejects = 0;
  let liveMetaInbound = 0;
  let persistFailures = 0;
  for (const row of rows) {
    const received = Date.parse(String(row.received_at ?? ""));
    const age = Number.isFinite(received) ? Date.now() - received : 0;
    const wamid = String(row.wamid ?? "");
    if (wamid && !wamid.startsWith("wamid.uat.") && !wamid.startsWith("wamid.v42persist.")) {
      liveMetaInbound += 1;
    }
    const recent = Number.isFinite(received) && received >= recentCutoff;
    if (!recent) continue;
    const visible = Boolean(row.first_visible_at || row.reply_sent_at);
    const greeting = /^(hi+|hello+|hey+|morning|thanks)\b/i.test(String(row.inbound_text ?? "").trim());
    if (Number(row.identity_found) === 1 && greeting && !visible && age >= 3_000) greetingSilentOver3s += 1;
    if (Number(row.processed) === 0 && age > 0) {
      queueOldestMs = queueOldestMs == null ? age : Math.max(queueOldestMs, age);
    }
    if (row.dlq_at || String(row.error ?? "") === "DEAD_LETTER") dlqEvents += 1;
    if (row.signature_error || Number(row.webhook_status) === 403) signatureRejects += 1;
    if (Number(row.persist_ok) === 0 || row.persist_error) persistFailures += 1;
  }
  let ackWithoutFinalOver30s = 0;
  for (const row of recognised) {
    const received = Date.parse(String(row.received_at ?? ""));
    if (!Number.isFinite(received) || received < recentCutoff) continue;
    const age = Date.now() - received;
    const visible = Boolean(row.first_visible_at || row.acknowledgement_sent_at);
    const terminal = isWhatsAppTerminalState(row.terminal_state ? String(row.terminal_state) : null);
    if (visible && !row.reply_sent_at && !row.final_sent_at && !terminal && age >= 30_000) {
      ackWithoutFinalOver30s += 1;
    }
  }
  const circuits = await listOpenKnowledgeCircuits(env).catch(() => []);
  const health = classifyHealth({
    greetingSilentOver3s,
    silentOver3s: recognised.filter((row) => {
      const received = Date.parse(String(row.received_at ?? ""));
      if (!Number.isFinite(received) || received < recentCutoff) return false;
      return !row.first_visible_at && !row.reply_sent_at && Date.now() - received >= 3_000;
    }).length,
    queueOldestMs,
    dlqEvents,
    signatureRejects,
    persistFailures,
    ackWithoutFinalOver30s,
    knowledgeCircuitOpen: circuits.length,
  });
  return {
    recognisedMessages: recognised.length,
    firstVisibleP50Ms: percentile(firstVisible, 50),
    firstVisibleP95Ms: percentile(firstVisible, 95),
    finalP50Ms: percentile(finals, 50),
    finalP95Ms: percentile(finals, 95),
    silentOver3s: silent3,
    silentOver10s: silent10,
    stuckOver30s: stuck30,
    failedOutbound,
    queueLatencyP50Ms: percentile(queue, 50),
    typingSuccessRate: typingN ? Math.round((typingOk / typingN) * 100) : null,
    readStatusSuccessRate: readN ? Math.round((readOk / readN) * 100) : null,
    greetingSilentOver3s,
    queueOldestMs,
    dlqEvents,
    signatureRejects,
    liveMetaInbound,
    persistFailures,
    ackWithoutFinalOver30s,
    knowledgeCircuitOpen: circuits.length,
    healthState: health.healthState,
    redReasons: health.redReasons,
  };
}

function classifyHealth(input: {
  greetingSilentOver3s: number;
  silentOver3s: number;
  queueOldestMs: number | null;
  dlqEvents: number;
  signatureRejects: number;
  persistFailures: number;
  ackWithoutFinalOver30s: number;
  knowledgeCircuitOpen: number;
}): { healthState: "GREEN" | "AMBER" | "RED"; redReasons: string[] } {
  const redReasons: string[] = [];
  if (input.greetingSilentOver3s > 0) redReasons.push("greeting_no_reply_over_3s");
  if (input.silentOver3s > 0) redReasons.push("recognised_no_first_visible_over_3s");
  if ((input.queueOldestMs ?? 0) > 10_000) redReasons.push("queue_oldest_over_10s");
  if (input.dlqEvents > 0) redReasons.push("whatsapp_dlq_event");
  if (input.signatureRejects > 0) redReasons.push("webhook_signature_rejected");
  if (input.persistFailures > 0) redReasons.push("inbound_persist_failed");
  if (input.ackWithoutFinalOver30s > 0) redReasons.push("ack_without_final_over_30s");
  if (input.knowledgeCircuitOpen > 0) redReasons.push("knowledge_circuit_open");
  if (redReasons.length) return { healthState: "RED", redReasons };
  return { healthState: "GREEN", redReasons };
}

export function whatsappAlertSignals(inbox: Awaited<ReturnType<typeof listWhatsAppInbox>>): Array<{
  category: string;
  severity: "high" | "medium";
  evidence: Record<string, unknown>;
}> {
  const signals: Array<{ category: string; severity: "high" | "medium"; evidence: Record<string, unknown> }> = [];
  if (inbox.consecutiveFailedReplies >= 3) {
    signals.push({
      category: "whatsapp_consecutive_failures",
      severity: "high",
      evidence: { count: inbox.consecutiveFailedReplies },
    });
  }
  if (inbox.stuckCount > 0) {
    signals.push({
      category: "whatsapp_stuck",
      severity: "high",
      evidence: { stuckCount: inbox.stuckCount },
    });
  }
  const metrics = inbox.metrics;
  if (metrics?.healthState === "RED") {
    signals.push({
      category: "whatsapp_health_red",
      severity: "high",
      evidence: { reasons: metrics.redReasons, silentOver3s: metrics.silentOver3s, dlqEvents: metrics.dlqEvents },
    });
  }
  return signals;
}
