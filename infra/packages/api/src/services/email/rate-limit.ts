import { nowIso } from "../../db/mappers";

const WINDOW_MS = 15 * 60 * 1000;
const IP_LIMIT = 8;
const EMAIL_LIMIT = 4;

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

function windowStart(nowMs = Date.now()): string {
  const bucket = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS;
  return new Date(bucket).toISOString();
}

async function increment(db: D1Database, scopeKey: string): Promise<number> {
  const start = windowStart();
  await db
    .prepare(
      `INSERT INTO email_rate_limits (scope_key, window_start, request_count)
       VALUES (?, ?, 1)
       ON CONFLICT(scope_key, window_start) DO UPDATE SET request_count = request_count + 1`,
    )
    .bind(scopeKey, start)
    .run();

  const row = await db
    .prepare(
      `SELECT request_count FROM email_rate_limits WHERE scope_key = ? AND window_start = ?`,
    )
    .bind(scopeKey, start)
    .first<{ request_count: number }>();

  return Number(row?.request_count ?? 1);
}

export async function checkPasswordResetRateLimit(
  db: D1Database,
  input: { ip: string; email: string },
): Promise<RateLimitResult> {
  const ipKey = `password_reset:ip:${input.ip.trim() || "unknown"}`;
  const emailKey = `password_reset:email:${input.email.trim().toLowerCase()}`;

  const ipCount = await increment(db, ipKey);
  if (ipCount > IP_LIMIT) {
    return { allowed: false, retryAfterSeconds: Math.ceil(WINDOW_MS / 1000) };
  }

  const emailCount = await increment(db, emailKey);
  if (emailCount > EMAIL_LIMIT) {
    return { allowed: false, retryAfterSeconds: Math.ceil(WINDOW_MS / 1000) };
  }

  return { allowed: true };
}

export async function pruneOldRateLimits(db: D1Database): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await db
    .prepare("DELETE FROM email_rate_limits WHERE window_start < ?")
    .bind(cutoff)
    .run();
}

export { nowIso };
