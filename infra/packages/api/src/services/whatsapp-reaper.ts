import type { Env } from "../env";
import { outboundAiEnabled } from "./whatsapp-assets";
import { FIRST_RESPONSE_FAILSAFE_COPY, WATCHDOG_STILL_WORKING_COPY } from "./whatsapp-fast-lane";
import { isWhatsAppTerminalState, stampWhatsAppLifecycle } from "./whatsapp-lifecycle";
import { HARD_TIMEOUT_MS, STUCK_INCIDENT_MS } from "./whatsapp-latency";
import { STUCK_RECOVERY_REPLY } from "./whatsapp-realtime";
import { sendWhatsAppText } from "./whatsapp-send";
import {
  evaluateWatchdogProgressGate,
  latestTimestampMs,
  WATCHDOG_DELAY_COPY,
  WATCHDOG_PROGRESS_COPY,
  WATCHDOG_TIMEOUT_COPY,
} from "./whatsapp-watchdog";
import { PROGRESS_MIN_INTERVAL_MS } from "./whatsapp-latency";
import { ensureWhatsAppInboundTable } from "./whatsapp-webhook";

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
  if (isWhatsAppTerminalState(row.terminal_state)) {
    return { recovered: false, reason: "already_terminal" };
  }
  if (row.recover_sent_at) return { recovered: false, reason: "already_recovered" };
  const ageMs = Date.now() - Date.parse(row.received_at);
  const visible = Boolean(row.reply_sent_at || row.first_visible_at);
  if (visible && (!Number.isFinite(ageMs) || ageMs < HARD_TIMEOUT_MS)) {
    return { recovered: false, reason: "ack_pending_final" };
  }
  if (!visible && (!Number.isFinite(ageMs) || ageMs < STUCK_INCIDENT_MS)) {
    return { recovered: false, reason: "not_stuck_yet" };
  }

  const sender = row.sender_e164 || senderFromPayload(row.payload_json);
  if (sender && outboundAiEnabled(env)) {
    await sendWhatsAppText(env, {
      toE164: sender,
      body: visible ? WATCHDOG_TIMEOUT_COPY : RECOVERY_COPY,
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
         AND (
           (first_visible_at IS NULL AND reply_sent_at IS NULL)
           OR received_at <= datetime('now', '-60 seconds')
         )
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
  input: { eventId: string; wamid: string | null; stage: "t5" | "t10" | "t15" | "t30" | "t60"; receivedAt: string },
): Promise<{ acted: boolean; reason: string }> {
  const targetMs =
    input.stage === "t5"
      ? 5_000
      : input.stage === "t10"
        ? 10_000
        : input.stage === "t15"
          ? 15_000
          : input.stage === "t30"
            ? 30_000
            : 60_000;
  const received = Date.parse(input.receivedAt);
  const age = Number.isFinite(received) ? Date.now() - received : targetMs;
  if (age + 250 < targetMs) {
    const delaySeconds = Math.max(1, Math.ceil((targetMs - age) / 1000));
    const { enqueueWhatsAppInbound } = await import("./whatsapp-webhook");
    await enqueueWhatsAppInbound(
      env,
      {
        kind: "whatsapp_watchdog",
        eventId: input.eventId,
        receivedAt: input.receivedAt,
        signatureValid: true,
        wamid: input.wamid ?? undefined,
        stage: input.stage,
      },
      { delaySeconds },
    ).catch(() => false);
    return { acted: false, reason: "requeued" };
  }
  const wamid = input.wamid;
  if (!wamid) return { acted: false, reason: "missing_wamid" };
  await ensureWhatsAppInboundTable(env);
  let row: {
    sender_e164: string | null;
    first_visible_at: string | null;
    reply_sent_at: string | null;
    acknowledgement_sent_at?: string | null;
    terminal_state: string | null;
    identity_found: number;
    inbound_text?: string | null;
    payload_json?: string | null;
    progress_sent_at?: string | null;
    delay_sent_at?: string | null;
  } | null = null;
  try {
    row = await env.DB.prepare(
      `SELECT sender_e164, first_visible_at, reply_sent_at, acknowledgement_sent_at,
              terminal_state, identity_found, inbound_text, payload_json,
              progress_sent_at, delay_sent_at
       FROM whatsapp_inbound_events WHERE wamid = ? OR id = ? LIMIT 1`,
    )
      .bind(wamid, input.eventId)
      .first();
  } catch {
    row = await env.DB.prepare(
      `SELECT sender_e164, first_visible_at, reply_sent_at, acknowledgement_sent_at,
              terminal_state, identity_found, inbound_text, payload_json
       FROM whatsapp_inbound_events WHERE wamid = ? OR id = ? LIMIT 1`,
    )
      .bind(wamid, input.eventId)
      .first()
      .catch(() => null);
  }
  if (row && Number(row.identity_found) !== 1) return { acted: false, reason: "not_recognised" };
  if (isWhatsAppTerminalState(row?.terminal_state)) {
    return { acted: false, reason: "already_terminal" };
  }
  const visible = Boolean(row?.first_visible_at || row?.reply_sent_at || row?.acknowledgement_sent_at);
  const sender = row?.sender_e164 || senderFromPayload(row?.payload_json);
  const now = new Date().toISOString();

  if (input.stage === "t5") {
    await stampWhatsAppLifecycle(env, wamid, { watchdog5sAt: now });
    if (visible) return { acted: false, reason: "already_visible" };
    if (sender && outboundAiEnabled(env)) {
      await sendWhatsAppText(env, {
        toE164: sender,
        body: FIRST_RESPONSE_FAILSAFE_COPY,
        inCustomerServiceWindow: true,
      }).catch(() => undefined);
    }
    await stampWhatsAppLifecycle(env, wamid, {
      state: "acknowledged",
      firstVisibleAt: now,
      acknowledgementSentAt: now,
      ackSendOk: sender ? 1 : 0,
      lastError: "watchdog_t5",
    });
    return { acted: true, reason: "t5_recovery" };
  }

  if (input.stage === "t10") {
    if (visible) return { acted: false, reason: "already_visible" };
    if (sender && outboundAiEnabled(env)) {
      await sendWhatsAppText(env, {
        toE164: sender,
        body: WATCHDOG_STILL_WORKING_COPY,
        inCustomerServiceWindow: true,
      }).catch(() => undefined);
    }
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

  if (input.stage === "t15") {
    await stampWhatsAppLifecycle(env, wamid, { watchdog15sAt: now });
    if (!visible) return { acted: false, reason: "not_acked" };
    const blocked = await conversationBlocksProgress(env, sender, wamid, Date.now(), input.receivedAt);
    if (blocked) return { acted: false, reason: blocked };
    const gate = evaluateWatchdogProgressGate({
      terminalState: row?.terminal_state,
      replySentAt: row?.reply_sent_at,
      acknowledgementSentAt: row?.acknowledgement_sent_at,
      firstVisibleAt: row?.first_visible_at,
      progressSentAt: row?.progress_sent_at,
      delaySentAt: row?.delay_sent_at,
    });
    if (!gate.allow) return { acted: false, reason: gate.reason };
    if (sender && outboundAiEnabled(env)) {
      await sendWhatsAppText(env, {
        toE164: sender,
        body: WATCHDOG_PROGRESS_COPY,
        inCustomerServiceWindow: true,
      }).catch(() => undefined);
    }
    await stampWhatsAppLifecycle(env, wamid, {
      progressSentAt: now,
      userStage: "searching_documents",
    });
    return { acted: true, reason: "t15_progress" };
  }

  if (input.stage === "t30") {
    await stampWhatsAppLifecycle(env, wamid, { watchdog30sAt: now });
    if (!visible) {
      return recoverStuckWhatsAppTurn(env, wamid).then((result) => ({
        acted: result.recovered,
        reason: result.reason,
      }));
    }
    const blocked = await conversationBlocksProgress(env, sender, wamid, Date.now(), input.receivedAt);
    if (blocked) return { acted: false, reason: blocked };
    const gate = evaluateWatchdogProgressGate({
      terminalState: row?.terminal_state,
      replySentAt: row?.reply_sent_at,
      acknowledgementSentAt: row?.acknowledgement_sent_at,
      firstVisibleAt: row?.first_visible_at,
      progressSentAt: row?.progress_sent_at,
      delaySentAt: row?.delay_sent_at,
    });
    if (!gate.allow) return { acted: false, reason: gate.reason };
    if (sender && outboundAiEnabled(env)) {
      await sendWhatsAppText(env, {
        toE164: sender,
        body: WATCHDOG_DELAY_COPY,
        inCustomerServiceWindow: true,
      }).catch(() => undefined);
    }
    await stampWhatsAppLifecycle(env, wamid, {
      delaySentAt: now,
      lastError: "ack_no_final_over_30s",
    });
    return { acted: true, reason: "t30_quality_warning" };
  }

  await stampWhatsAppLifecycle(env, wamid, { watchdog60sAt: now });
  if (sender && outboundAiEnabled(env)) {
    await sendWhatsAppText(env, {
      toE164: sender,
      body: WATCHDOG_TIMEOUT_COPY,
      inCustomerServiceWindow: true,
    }).catch(() => undefined);
  }
  await stampWhatsAppLifecycle(env, wamid, {
    state: "failed_notified",
    terminal: "failed_notified",
    replySentAt: now,
    firstVisibleAt: now,
    finalSentAt: now,
    recoverSentAt: now,
    lastError: "watchdog_t60_timeout",
    finalSendOk: sender ? 1 : 0,
  });
  try {
    await env.DB.prepare(
      `UPDATE whatsapp_inbound_events
       SET processed = 1, processed_at = COALESCE(processed_at, ?), error = 'WATCHDOG_T60'
       WHERE wamid = ? AND processed = 0`,
    )
      .bind(now, wamid)
      .run();
  } catch {
    // processed flag is best-effort
  }
  return { acted: true, reason: "t60_force_terminal" };
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

async function conversationBlocksProgress(
  env: Env,
  sender: string | null,
  wamid: string,
  nowMs: number,
  receivedAt?: string,
): Promise<string | null> {
  if (!sender) return null;
  const selfReceived = receivedAt ? Date.parse(receivedAt) : 0;
  try {
    const result = await env.DB.prepare(
      `SELECT wamid, reply_sent_at, terminal_state, progress_sent_at, delay_sent_at,
              acknowledgement_sent_at, first_visible_at, received_at
       FROM whatsapp_inbound_events
       WHERE sender_e164 = ? AND received_at >= ?
       ORDER BY received_at DESC
       LIMIT 8`,
    )
      .bind(sender, new Date(nowMs - 180_000).toISOString())
      .all<{
        wamid: string | null;
        reply_sent_at: string | null;
        terminal_state: string | null;
        progress_sent_at: string | null;
        delay_sent_at: string | null;
        acknowledgement_sent_at: string | null;
        first_visible_at: string | null;
        received_at: string | null;
      }>();
    for (const other of result.results ?? []) {
      if (!other.wamid || other.wamid === wamid) continue;
      const otherReceived = other.received_at ? Date.parse(other.received_at) : 0;
      const newer = Number.isFinite(otherReceived) && Number.isFinite(selfReceived) && otherReceived > selfReceived;
      if (newer && (other.reply_sent_at || (other.terminal_state && String(other.terminal_state).trim()))) {
        return "superseded_by_newer_result";
      }
      const last = latestTimestampMs(other.progress_sent_at, other.delay_sent_at);
      if (last != null && nowMs - last < PROGRESS_MIN_INTERVAL_MS) {
        return "conversation_progress_interval";
      }
    }
  } catch {
    return null;
  }
  return null;
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
