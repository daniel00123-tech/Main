export const MCP_TIMEOUT_MS = 15_000;
export const KNOWLEDGE_SEARCH_TIMEOUT_MS = 15_000;
export const FETCH_TIMEOUT_MS = 15_000;
export const SYNTHESIS_TIMEOUT_MS = 10_000;
export const D1_TIMEOUT_MS = 10_000;
export const OVERALL_TURN_TIMEOUT_MS = 60_000;
export const SEARCH_CANDIDATE_LIMIT = 8;
export const FETCH_TOP_LIMIT = 2;

export const USER_STAGES = [
  "understanding_request",
  "searching_documents",
  "fetching_source",
  "preparing_answer",
] as const;

export type WhatsAppUserStage = (typeof USER_STAGES)[number];

export type BoundedTimeoutResult<T> =
  | { ok: true; value: T; timedOut: false }
  | { ok: false; value: null; timedOut: true; label: string };

/**
 * Bound every downstream await. Does not cancel an in-flight Worker fetch
 * (gateway has no AbortSignal), but the WhatsApp turn proceeds instead of hanging.
 */
export async function withBoundedTimeout<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<BoundedTimeoutResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raced = await Promise.race([
      work.then((value) => ({ ok: true as const, value, timedOut: false as const })),
      new Promise<BoundedTimeoutResult<T>>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, value: null, timedOut: true, label }), ms);
      }),
    ]);
    return raced;
  } catch {
    return { ok: false, value: null, timedOut: true, label };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function slowestLatencyStage(parts: Record<string, number | null | undefined>): string | null {
  let name: string | null = null;
  let max = -1;
  for (const [key, value] of Object.entries(parts)) {
    if (value == null || !Number.isFinite(value) || value < 0) continue;
    if (value > max) {
      max = value;
      name = key;
    }
  }
  return name;
}
