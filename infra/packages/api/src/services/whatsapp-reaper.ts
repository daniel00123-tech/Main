import type { Env } from "../env";
import { outboundAiEnabled } from "./whatsapp-assets";
import { stampWhatsAppLifecycle } from "./whatsapp-lifecycle";
import { STUCK_INCIDENT_MS } from "./whatsapp-latency";
import { FIRST_RESPONSE_FAILSAFE_COPY } from "./whatsapp-fast-lane";
import { FIRST_RESPONSE_FAILSAFE_COPY } from "./whatsapp-fast-lane";
import { STUCK_RECOVERY_REPLY } from "./whatsapp-realtime";
import { sendWhatsAppText } from "./whatsapp-send";
import { ensureWhatsAppInboundTable } from "./whatsapp-webhook";
import { outboundAiEnabled } from "./whatsapp-assets";

const RECOVERY_COPY = STUCK_RECOVERY_REPLY;

export async function recoverStuckWhatsAppTurn(
  env: Env,
  wamid: string,
): Promise<{ recovered: boolean; reason: string }> {
  if (!wamid) return { recovered: false, reason: "missing_wamid" };
  await ensureWhatsAppInboundTable(env);
  let row: {
    wamid: string | null;
    sender_e164: string | null;
    identity_found: number;
    processed: number;
    terminal_state: string | null;
    first_visible_at: string | null;
    reply_sent_at: string | null;
    recover_sent_at: string | null;
    received_at: string;
    payload_json?: string | null;
  } | null = null;
  try {
    row = await env.DB.prepare(
      `SELECT wamid, sender_e164, identity_found, processed, terminal_state,
              first_visible_at, reply_sent_at, recover_sent_at, received_at, payload_json
       FROM whatsapp_inbound_events WHERE wamid = ? LIMIT 1`,
    )
      .bind(wamid)
      .first();
  } catch {
    row = await env.DB.prepare(
      `SELECT wamid, sender_e164, identity_found, processed, received_at, payload_json
       FROM whatsapp_inbound_events WHERE wamid = ? LIMIT 1`,
    )
      .bind(wamid)
      .first();
  }
  if (!row) return { recovered: false, reason: "not_found" };
  if (Number(row.identity_found) !== 1) return { recovered: false, reason: "not_recognised" };
  if (row.terminal_state && /reply_sent|clarification_sent|permission_denied|no_result|failed_notified/.test(row.terminal_state)) {
    return { recovered: false, reason: "already_terminal" };
  }
  if (row.reply_sent_at || row.first_visible_at) return { recovered: false, reason: "already_visible" };
  if (row.recover_sent_at) return { recovered: false, reason: "already_recovered" };
  const ageMs = Date.now() - Date.parse(row.received_at);
  if (!Number.isFinite(ageMs) || ageMs < STUCK_INCIDENT_MS) {
    return { recovered: false, reason: "not_stuck_yet" };
  }

  const sender = row.sender_e164 || senderFromPayload(row.payload_json);
  if (sender && outboundAiEnabled(env)) {
    await sendWhatsAppText(env, {
      toE164: sender,
      body: RECOVERY_COPY,
      inCustomerServiceWindow: true,
    }).catch(() => undefined);
  }
  const now = new Date().toISOString();
  await stampWhatsAppLifecycle(env, wamid, {
    state: "failed_notified",
    terminal: "failed_notified",
    replySentAt: now,
    firstVisibleAt: now,
    recoverSentAt: now,
    lastError: "stuck_reaper",
    finalSendOk: sender ? 1 : 0,
  });
  try {
    await env.DB.prepare(
      `UPDATE whatsapp_inbound_events
       SET processed = 1, processed_at = COALESCE(processed_at, ?), error = 'STUCK_RECOVERED'
       WHERE wamid = ? AND processed = 0`,
    )
      .bind(now, wamid)
      .run();
  } catch {
    // processed flag is best-effort
  }
  return { recovered: true, reason: "failed_notified" };
}

export async function sweepStuckWhatsAppTurns(env: Env): Promise<{ scanned: number; recovered: number }> {
  await ensureWhatsAppInboundTable(env);
  const cutoff = new Date(Date.now() - STUCK_INCIDENT_MS).toISOString();
  let rows: Array<{ wamid: string | null }> = [];
  try {
    const result = await env.DB.prepare(
      `SELECT wamid FROM whatsapp_inbound_events
       WHERE identity_found = 1
         AND received_at <= ?
         AND (terminal_state IS NULL OR terminal_state = '')
         AND (recover_sent_at IS NULL OR recover_sent_at = '')
         AND first_visible_at IS NULL
         AND reply_sent_at IS NULL
       ORDER BY received_at ASC
       LIMIT 20`,
    )
      .bind(cutoff)
      .all();
    rows = (result.results ?? []) as Array<{ wamid: string | null }>;
  } catch {
    const result = await env.DB.prepare(
      `SELECT wamid FROM whatsapp_inbound_events
       WHERE identity_found = 1 AND processed = 0 AND received_at <= ?
       ORDER BY received_at ASC
       LIMIT 20`,
    )
      .bind(cutoff)
      .all();
    rows = (result.results ?? []) as Array<{ wamid: string | null }>;
  }
  let recovered = 0;
  for (const row of rows) {
    if (!row.wamid) continue;
    const result = await recoverStuckWhatsAppTurn(env, row.wamid);
    if (result.recovered) recovered += 1;
  }
  return { scanned: rows.length, recovered };
}

export async function applyWhatsAppWatchdogStage(
  env: Env,
  input: { eventId: string; wamid: string | null; stage: "t10" | "t30"; receivedAt: string },
): Promise<{ acted: boolean; reason: string }> {
  const targetMs = input.stage === "t10" ? 10_000 : 30_000;
  const received = Date.parse(input.receivedAt);
  const age = Number.isFinite(received) ? Date.now() - received : targetMs;
  if (age < targetMs) {
    await new Promise((resolve) => {
      setTimeout(resolve, targetMs - age);
    });
  }
  const wamid = input.wamid;
  if (!wamid) return { acted: false, reason: "missing_wamid" };
  await ensureWhatsAppInboundTable(env);
  let row: {
    sender_e164: string | null;
    first_visible_at: string | null;
    reply_sent_at: string | null;
    terminal_state: string | null;
    identity_found: number;
    payload_json?: string | null;
  } | null = null;
  try {
    row = await env.DB.prepare(
      `SELECT sender_e164, first_visible_at, reply_sent_at, terminal_state, identity_found, payload_json
       FROM whatsapp_inbound_events WHERE wamid = ? OR id = ? LIMIT 1`,
    )
      .bind(wamid, input.eventId)
      .first();
  } catch {
    row = null;
  }
  if (row && Number(row.identity_found) !== 1) return { acted: false, reason: "not_recognised" };
  if (row?.terminal_state && /reply_sent|clarification_sent|permission_denied|no_result|failed_notified/.test(row.terminal_state)) {
    return { acted: false, reason: "already_terminal" };
  }
  const visible = Boolean(row?.first_visible_at || row?.reply_sent_at);
  if (input.stage === "t10") {
    if (visible) return { acted: false, reason: "already_visible" };
    const sender = row?.sender_e164 || senderFromPayload(row?.payload_json);
    if (sender && outboundAiEnabled(env)) {
      await sendWhatsAppText(env, {
        toE164: sender,
        body: FIRST_RESPONSE_FAILSAFE_COPY,
        inCustomerServiceWindow: true,
      }).catch(() => undefined);
    }
    const now = new Date().toISOString();
    await stampWhatsAppLifecycle(env, wamid, {
      state: "acknowledged",
      firstVisibleAt: now,
      acknowledgementSentAt: now,
      watchdog10sAt: now,
      ackSendOk: sender ? 1 : 0,
      lastError: "watchdog_t10",
    });
    return { acted: true, reason: "t10_failsafe" };
  }
  if (visible && row?.terminal_state) return { acted: false, reason: "already_final" };
  return recoverStuckWhatsAppTurn(env, wamid).then((result) => {
    void stampWhatsAppLifecycle(env, wamid, { watchdog30sAt: new Date().toISOString() });
    return { acted: result.recovered, reason: result.reason };
  });
}

export function scheduleStuckTurnWatch(
  waitUntil: ((promise: Promise<unknown>) => void) | undefined,
  env: Env,
  wamid: string,
): void {
  if (!wamid) return;
  const work = sleepThenRecover(env, wamid);
  if (waitUntil) {
    waitUntil(work);
    return;
  }
  void work;
}

async function sleepThenRecover(env: Env, wamid: string): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, STUCK_INCIDENT_MS + 1_000);
  });
  await recoverStuckWhatsAppTurn(env, wamid).catch(() => undefined);
}

function senderFromPayload(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      entry?: Array<{
        changes?: Array<{ value?: { messages?: Array<{ from?: string }> } }>;
      }>;
    };
    for (const entry of parsed.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const from = change.value?.messages?.[0]?.from;
        const digits = String(from ?? "").replace(/\D/g, "");
        if (digits) return `+${digits}`;
      }
    }
  } catch {
    return null;
  }
  return null;
}
