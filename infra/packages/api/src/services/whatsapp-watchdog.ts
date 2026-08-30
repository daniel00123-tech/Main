import {
  ACK_DECISION_MS,
  DELAY_NOTICE_MS,
  HARD_TIMEOUT_MS,
  PROGRESS_AFTER_MS,
  sleepMs,
} from "./whatsapp-latency";

export const WATCHDOG_ACK_COPY = [
  "Got it — I’m checking that now.",
  "Thanks — I’m looking into that for you.",
  "Understood — I’m checking your connected systems now.",
] as const;

export const WATCHDOG_PROGRESS_COPY =
  "I’ve found the right area — I’m still pulling the details together.";

export const WATCHDOG_DELAY_COPY =
  "This is taking longer than usual, but I’m still working on it.";

export const WATCHDOG_TIMEOUT_COPY =
  "That took longer than expected and I couldn’t complete it this time. Please try again.";

export type WhatsAppWatchdogKind = "ack" | "progress" | "delay" | "timeout";

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

  if (options?.skipAck) {
    const done = await Promise.race([
      wrapped,
      sleepMs(HARD_TIMEOUT_MS).then(() => ({ ok: false as const, timeout: true })),
    ]);
    if ("timeout" in done && done.timeout && !settled) {
      await send("timeout", WATCHDOG_TIMEOUT_COPY);
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

  const rest = await Promise.race([
    wrapped,
    (async () => {
      await sleepMs(PROGRESS_AFTER_MS - ACK_DECISION_MS);
      if (!settled) {
        progressSent = await send("progress", WATCHDOG_PROGRESS_COPY);
      }
      await sleepMs(DELAY_NOTICE_MS - PROGRESS_AFTER_MS);
      if (!settled) {
        delaySent = await send("delay", WATCHDOG_DELAY_COPY);
      }
      await sleepMs(HARD_TIMEOUT_MS - DELAY_NOTICE_MS);
      if (!settled) {
        await send("timeout", WATCHDOG_TIMEOUT_COPY);
        return { timeout: true as const };
      }
      return wrapped;
    })(),
  ]);

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
