import type { Env } from "../env";

export const CHAT_LOCK_TTL_MS = 8_000;

export type WhatsAppChatLockResult = {
  acquired: boolean;
  expired: boolean;
  failOpen: boolean;
};

/**
 * Per-chat mutex with a hard TTL. Greetings must fail-open.
 * Never wait for the lock holder — the independent watchdog owns recovery.
 */
export async function acquireWhatsAppChatLock(
  env: Env,
  input: { chatKey: string; wamid: string; ttlMs?: number; failOpen?: boolean },
): Promise<WhatsAppChatLockResult> {
  const ttlMs = input.ttlMs ?? CHAT_LOCK_TTL_MS;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const expiresAt = new Date(now + ttlMs).toISOString();
  try {
    await ensureWhatsAppChatLocksTable(env);
    const existing = await env.DB.prepare(
      `SELECT wamid, expires_at FROM whatsapp_chat_locks WHERE chat_key = ? LIMIT 1`,
    )
      .bind(input.chatKey)
      .first<{ wamid: string; expires_at: string }>();
    if (existing) {
      const expiry = Date.parse(existing.expires_at);
      const expired = !Number.isFinite(expiry) || expiry <= now;
      if (!expired && existing.wamid !== input.wamid) {
        return { acquired: false, expired: false, failOpen: Boolean(input.failOpen) };
      }
      await env.DB.prepare(
        `UPDATE whatsapp_chat_locks SET wamid = ?, locked_at = ?, expires_at = ? WHERE chat_key = ?`,
      )
        .bind(input.wamid, nowIso, expiresAt, input.chatKey)
        .run();
      return { acquired: true, expired, failOpen: false };
    }
    await env.DB.prepare(
      `INSERT INTO whatsapp_chat_locks (chat_key, wamid, locked_at, expires_at) VALUES (?, ?, ?, ?)`,
    )
      .bind(input.chatKey, input.wamid, nowIso, expiresAt)
      .run();
    return { acquired: true, expired: false, failOpen: false };
  } catch {
    return { acquired: false, expired: true, failOpen: true };
  }
}

export async function releaseWhatsAppChatLock(
  env: Env,
  input: { chatKey: string; wamid: string },
): Promise<void> {
  try {
    await env.DB.prepare(`DELETE FROM whatsapp_chat_locks WHERE chat_key = ? AND wamid = ?`)
      .bind(input.chatKey, input.wamid)
      .run();
  } catch {
    // Release is best-effort; TTL covers a crash before finally.
  }
}

export async function ensureWhatsAppChatLocksTable(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS whatsapp_chat_locks (
       chat_key TEXT PRIMARY KEY,
       wamid TEXT NOT NULL,
       locked_at TEXT NOT NULL,
       expires_at TEXT NOT NULL
     )`,
  ).run();
}
