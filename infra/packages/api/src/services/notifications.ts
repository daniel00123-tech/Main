import { newId, nowIso } from "../db/mappers";

export type NotificationSeverity = "info" | "warning" | "critical";

export type NotificationInput = {
  companyId: string;
  userId?: string | null;
  type: string;
  severity?: NotificationSeverity;
  title: string;
  body: string;
  href?: string | null;
  dedupKey?: string | null;
  dedupWindowHours?: number;
};

export async function createNotification(
  db: D1Database,
  input: NotificationInput,
): Promise<{ id: string; created: boolean }> {
  if (input.dedupKey) {
    const windowStart = new Date(
      Date.now() - (input.dedupWindowHours ?? 24) * 60 * 60 * 1000,
    ).toISOString();
    const existing = await db
      .prepare(
        `SELECT id FROM notifications
         WHERE company_id = ? AND dedup_key = ? AND created_at >= ?
         LIMIT 1`,
      )
      .bind(input.companyId, input.dedupKey, windowStart)
      .first();
    if (existing) return { id: String(existing.id), created: false };
  }

  const id = newId("notif");
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO notifications (
        id, company_id, user_id, notification_type, severity,
        title, body, href, dedup_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.companyId,
      input.userId ?? null,
      input.type,
      input.severity ?? "info",
      input.title,
      input.body,
      input.href ?? null,
      input.dedupKey ?? null,
      now,
    )
    .run();
  return { id, created: true };
}

export async function listNotifications(
  db: D1Database,
  input: { companyId: string; userId?: string | null; limit?: number; unreadOnly?: boolean },
) {
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
  const rows = await db
    .prepare(
      `SELECT * FROM notifications
       WHERE company_id = ?
         AND (user_id IS NULL OR user_id = ?)
         ${input.unreadOnly ? "AND read_at IS NULL" : ""}
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .bind(input.companyId, input.userId ?? null, limit)
    .all();

  return (rows.results ?? []).map((row) => ({
    id: String(row.id),
    companyId: String(row.company_id),
    userId: row.user_id ? String(row.user_id) : null,
    type: String(row.notification_type),
    severity: String(row.severity) as NotificationSeverity,
    title: String(row.title),
    body: String(row.body),
    href: row.href ? String(row.href) : null,
    readAt: row.read_at ? String(row.read_at) : null,
    createdAt: String(row.created_at),
  }));
}

export async function countUnreadNotifications(
  db: D1Database,
  companyId: string,
  userId?: string | null,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM notifications
       WHERE company_id = ? AND read_at IS NULL
         AND (user_id IS NULL OR user_id = ?)`,
    )
    .bind(companyId, userId ?? null)
    .first();
  return Number(row?.count ?? 0);
}

export async function markNotificationRead(db: D1Database, id: string, companyId: string) {
  await db
    .prepare(
      `UPDATE notifications SET read_at = ? WHERE id = ? AND company_id = ? AND read_at IS NULL`,
    )
    .bind(nowIso(), id, companyId)
    .run();
}

export async function markAllNotificationsRead(
  db: D1Database,
  companyId: string,
  userId?: string | null,
) {
  await db
    .prepare(
      `UPDATE notifications SET read_at = ?
       WHERE company_id = ? AND read_at IS NULL
         AND (user_id IS NULL OR user_id = ?)`,
    )
    .bind(nowIso(), companyId, userId ?? null)
    .run();
}
