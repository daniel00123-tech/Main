import { nowIso } from "../db/mappers";
import type { Env } from "../env";
import { isWhatsAppTerminalState } from "./whatsapp-lifecycle";
import { STUCK_INCIDENT_MS } from "./whatsapp-latency";
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
  const stuck = !visible && ageMs >= STUCK_INCIDENT_MS && !isWhatsAppTerminalState(terminal);
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
  return {
    items,
    stuckCount: items.filter((item) => item.stuck).length,
    processingCount: items.filter((item) => item.status === "processing").length,
    failedCount: items.filter((item) => item.status === "failed").length,
    consecutiveFailedReplies: recentFailed.length === 3 ? 3 : 0,
  };
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
  return signals;
}
