import { nowIso } from "../db/mappers";

export type PlatformHeartbeatKey =
  | "microsoft_scheduler"
  | "automation_scheduler"
  | "microsoft_queue"
  | "automation_queue"
  | "quality_loop";

export async function recordPlatformHeartbeat(
  db: D1Database,
  input: {
    key: PlatformHeartbeatKey;
    label: string;
    success: boolean;
    error?: string | null;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO platform_ops_heartbeats (key, label, last_run_at, last_success_at, last_error, detail_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         label = excluded.label,
         last_run_at = excluded.last_run_at,
         last_success_at = CASE WHEN excluded.last_success_at IS NOT NULL THEN excluded.last_success_at ELSE platform_ops_heartbeats.last_success_at END,
         last_error = excluded.last_error,
         detail_json = excluded.detail_json,
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.key,
      input.label,
      now,
      input.success ? now : null,
      input.success ? null : (input.error ?? "Unknown error"),
      input.detail ? JSON.stringify(input.detail) : null,
      now,
    )
    .run();
}

export async function listPlatformHeartbeats(db: D1Database): Promise<
  Array<{
    key: string;
    label: string;
    lastRunAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
    detail: Record<string, unknown> | null;
    updatedAt: string;
  }>
> {
  const rows = await db
    .prepare(`SELECT * FROM platform_ops_heartbeats ORDER BY key ASC`)
    .all<{
      key: string;
      label: string;
      last_run_at: string | null;
      last_success_at: string | null;
      last_error: string | null;
      detail_json: string | null;
      updated_at: string;
    }>();

  return (rows.results ?? []).map((row) => ({
    key: row.key,
    label: row.label,
    lastRunAt: row.last_run_at,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
    detail: row.detail_json ? (JSON.parse(row.detail_json) as Record<string, unknown>) : null,
    updatedAt: row.updated_at,
  }));
}
