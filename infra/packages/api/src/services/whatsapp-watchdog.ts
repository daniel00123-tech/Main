import {
  ACK_DECISION_MS,
  DELAY_NOTICE_MS,
  HARD_TIMEOUT_MS,
  PROGRESS_AFTER_MS,
  PROGRESS_MIN_INTERVAL_MS,
  sleepMs,
} from "./whatsapp-latency";
import { isWhatsAppTerminalState } from "./whatsapp-lifecycle";

export const WATCHDOG_ACK_COPY = [
  "Got it 👍 I’m checking now.",
  "No problem — I’m looking into that.",
  "Thanks — I’ll check that for you.",
  "Understood. Let me look into it.",
] as const;

export const WATCHDOG_PROGRESS_COPY = "Still searching your documents — I’ll send the answer shortly.";

export const WATCHDOG_DELAY_COPY =
  "This is taking longer than usual, but I’m still working on it.";

export const WATCHDOG_TIMEOUT_COPY =
  "That took longer than expected and I couldn’t complete it this time. Please try again.";

export type WhatsAppWatchdogKind = "ack" | "progress" | "delay" | "timeout";

export type WatchdogProgressGateInput = {
  terminalState?: string | null;
  replySentAt?: string | null;
  acknowledgementSentAt?: string | null;
  firstVisibleAt?: string | null;
  progressSentAt?: string | null;
  delaySentAt?: string | null;
  nowMs?: number;
};

/**
 * At most one progress/status line per minute. Never immediately after ACK
 * or after a document/result has already been sent.
 */
export function evaluateWatchdogProgressGate(input: WatchdogProgressGateInput): {
  allow: boolean;
  reason: string;
} {
  if (isWhatsAppTerminalState(input.terminalState)) {
    return { allow: false, reason: "already_terminal" };
  }
  if (hasTimestamp(input.replySentAt)) {
    return { allow: false, reason: "result_already_sent" };
  }
  const now = input.nowMs ?? Date.now();
  const lastStatus = latestTimestampMs(input.progressSentAt, input.delaySentAt);
  if (lastStatus != null && now - lastStatus < PROGRESS_MIN_INTERVAL_MS) {
    return { allow: false, reason: "progress_min_interval" };
  }
  const ackAt = latestTimestampMs(input.acknowledgementSentAt, input.firstVisibleAt);
  if (ackAt != null && now - ackAt < PROGRESS_MIN_INTERVAL_MS) {
    return { allow: false, reason: "too_soon_after_ack" };
  }
  return { allow: true, reason: "ok" };
}

function hasTimestamp(value: string | null | undefined): boolean {
  return Boolean(value && String(value).trim());
}

export function latestTimestampMs(...values: Array<string | null | undefined>): number | null {
  let latest: number | null = null;
  for (const value of values) {
    if (!hasTimestamp(value)) continue;
    const ms = Date.parse(String(value));
    if (!Number.isFinite(ms)) continue;
    if (latest == null || ms > latest) latest = ms;
  }
  return latest;
}

export type WhatsAppWatchdogResult<T> = {
  result: T | null;
  timedOut: boolean;
  error: unknown;
  acknowledgementSent: boolean;
  progressSent: boolean;
  delaySent: boolean;
};

/**
 * Awaited watchdog — not fire-and-forget setTimeout.
 * If work finishes before ACK_DECISION_MS, the final answer replaces the ack.
 * Otherwise one ack is sent, then optional 20s/45s progress, then a 60s hard stop.
 */
export async function raceWithWhatsAppWatchdog<T>(
  work: Promise<T>,
  send: (kind: WhatsAppWatchdogKind, body: string) => Promise<boolean>,
  options?: { skipAck?: boolean; seed?: string },
): Promise<WhatsAppWatchdogResult<T>> {
  let settled = false;
  let acknowledgementSent = false;
  let progressSent = false;
  let delaySent = false;

  const wrapped = work
    .then((result) => {
      settled = true;
      return { ok: true as const, result };
    })
    .catch((error: unknown) => {
      settled = true;
      return { ok: false as const, error };
    });

  const runTails = async (alreadyAcked: boolean) => {
    const offset = alreadyAcked ? 0 : ACK_DECISION_MS;
    const ticks: Array<{ at: number; kind: WhatsAppWatchdogKind; body: string }> = [];
    if (PROGRESS_AFTER_MS < HARD_TIMEOUT_MS) {
      ticks.push({
        at: Math.max(0, PROGRESS_AFTER_MS - offset),
        kind: "progress",
        body: WATCHDOG_PROGRESS_COPY,
      });
    }
    if (DELAY_NOTICE_MS < HARD_TIMEOUT_MS) {
      ticks.push({
        at: Math.max(0, DELAY_NOTICE_MS - offset),
        kind: "delay",
        body: WATCHDOG_DELAY_COPY,
      });
    }
    ticks.push({
      at: Math.max(0, HARD_TIMEOUT_MS - offset),
      kind: "timeout",
      body: WATCHDOG_TIMEOUT_COPY,
    });
    ticks.sort((left, right) => left.at - right.at);
    let elapsed = 0;
    for (const tick of ticks) {
      await sleepMs(Math.max(0, tick.at - elapsed));
      elapsed = tick.at;
      if (settled) return wrapped;
      if (tick.kind === "progress") {
        progressSent = await send("progress", tick.body);
      } else if (tick.kind === "delay") {
        delaySent = await send("delay", tick.body);
      } else {
        await send("timeout", tick.body);
        return { timeout: true as const };
      }
    }
    return wrapped;
  };

  if (options?.skipAck) {
    const done = await Promise.race([wrapped, runTails(true)]);
    if ("timeout" in done && done.timeout) {
      return {
        result: null,
        timedOut: true,
        error: null,
        acknowledgementSent,
        progressSent,
        delaySent,
      };
    }
    if ("ok" in done && done.ok) {
      return {
        result: done.result,
        timedOut: false,
        error: null,
        acknowledgementSent,
        progressSent,
        delaySent,
      };
    }
    return {
      result: null,
      timedOut: false,
      error: "error" in done ? done.error : null,
      acknowledgementSent,
      progressSent,
      delaySent,
    };
  }

  const first = await Promise.race([
    wrapped,
    sleepMs(ACK_DECISION_MS).then(() => ({ tick: "ack" as const })),
  ]);

  if ("ok" in first && first.ok) {
    return {
      result: first.result,
      timedOut: false,
      error: null,
      acknowledgementSent: false,
      progressSent,
      delaySent,
    };
  }
  if ("ok" in first && !first.ok && !("tick" in first)) {
    return {
      result: null,
      timedOut: false,
      error: first.error,
      acknowledgementSent: false,
      progressSent,
      delaySent,
    };
  }

  if (!settled) {
    acknowledgementSent = await send("ack", pickAck(options?.seed ?? "ack"));
  }

  const rest = await Promise.race([wrapped, runTails(false)]);

  if ("timeout" in rest && rest.timeout) {
    return {
      result: null,
      timedOut: true,
      error: null,
      acknowledgementSent,
      progressSent,
      delaySent,
    };
  }
  if ("ok" in rest && rest.ok) {
    return {
      result: rest.result,
      timedOut: false,
      error: null,
      acknowledgementSent,
      progressSent,
      delaySent,
    };
  }
  return {
    result: null,
    timedOut: false,
    error: "error" in rest ? rest.error : null,
    acknowledgementSent,
    progressSent,
    delaySent,
  };
}

function pickAck(seed: string): string {
  let hash = 0;
  for (const char of seed) hash = (hash + char.charCodeAt(0)) % 2147483647;
  return WATCHDOG_ACK_COPY[Math.abs(hash) % WATCHDOG_ACK_COPY.length]!;
}
