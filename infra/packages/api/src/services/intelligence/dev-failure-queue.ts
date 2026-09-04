import { clusterKey, sanitiseMetadata } from "./failure-telemetry.js";
import type { EngineeringFailureEvent } from "./types.js";

export type EngineeringWorkItem = {
  id: string;
  clusterKey: string;
  category: string;
  capability: string | null;
  tool: string | null;
  occurrenceCount: number;
  status: "open" | "clustered" | "work_item" | "resolved";
  reproducible: boolean;
  autoDeploy: false;
  sampleCorrelationId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
};

type D1Like = {
  prepare(query: string): {
    bind(...values: unknown[]): { run(): Promise<unknown>; first<T = unknown>(): Promise<T | null>; all<T = unknown>(): Promise<{ results: T[] }> };
    run(): Promise<unknown>;
    first<T = unknown>(): Promise<T | null>;
    all<T = unknown>(): Promise<{ results: T[] }>;
  };
};

const ENSURE_EVENTS = `CREATE TABLE IF NOT EXISTS engineering_failure_events (
  id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  company_id TEXT,
  channel TEXT,
  capability TEXT,
  tool_name TEXT,
  model TEXT,
  provider TEXT,
  category TEXT NOT NULL,
  latency_ms INTEGER,
  outcome TEXT,
  metadata_json TEXT,
  cluster_key TEXT NOT NULL,
  created_at TEXT NOT NULL
)`;

const ENSURE_CLUSTERS = `CREATE TABLE IF NOT EXISTS engineering_failure_clusters (
  cluster_key TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  capability TEXT,
  tool_name TEXT,
  occurrence_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  work_item_id TEXT,
  sample_correlation_id TEXT,
  updated_at TEXT NOT NULL
)`;

export async function persistEngineeringFailures(
  db: D1Like | undefined,
  events: EngineeringFailureEvent[],
): Promise<{ stored: number; clusters: string[] }> {
  if (!db || events.length === 0) return { stored: 0, clusters: [] };
  await db.prepare(ENSURE_EVENTS).run();
  await db.prepare(ENSURE_CLUSTERS).run();
  const clusters = new Set<string>();
  for (const event of events) {
    const key = clusterKey(event);
    clusters.add(key);
    await db
      .prepare(
        `INSERT OR IGNORE INTO engineering_failure_events
          (id, correlation_id, company_id, channel, capability, tool_name, model, provider, category, latency_ms, outcome, metadata_json, cluster_key, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        event.id,
        event.correlationId,
        event.companyId,
        event.channel,
        event.capability,
        event.tool,
        event.model,
        event.provider,
        event.category,
        event.latencyMs,
        event.outcome,
        JSON.stringify(sanitiseMetadata(event.metadata)),
        key,
        event.createdAt,
      )
      .run();
    const existing = await db
      .prepare(`SELECT occurrence_count, first_seen_at, status FROM engineering_failure_clusters WHERE cluster_key = ?`)
      .bind(key)
      .first<{ occurrence_count: number; first_seen_at: string; status: string }>();
    if (existing) {
      const count = Number(existing.occurrence_count ?? 0) + 1;
      const status = count >= 3 && existing.status === "open" ? "clustered" : existing.status;
      await db
        .prepare(
          `UPDATE engineering_failure_clusters
           SET occurrence_count = ?, last_seen_at = ?, status = ?, sample_correlation_id = ?, updated_at = ?
           WHERE cluster_key = ?`,
        )
        .bind(count, event.createdAt, status, event.correlationId, event.createdAt, key)
        .run();
    } else {
      await db
        .prepare(
          `INSERT INTO engineering_failure_clusters
            (cluster_key, category, capability, tool_name, occurrence_count, first_seen_at, last_seen_at, status, work_item_id, sample_correlation_id, updated_at)
            VALUES (?, ?, ?, ?, 1, ?, ?, 'open', NULL, ?, ?)`,
        )
        .bind(key, event.category, event.capability, event.tool, event.createdAt, event.createdAt, event.correlationId, event.createdAt)
        .run();
    }
  }
  return { stored: events.length, clusters: [...clusters] };
}

export function shouldOpenEngineeringWorkItem(occurrenceCount: number): boolean {
  return occurrenceCount >= 3;
}

export function toWorkItem(row: {
  cluster_key: string;
  category: string;
  capability: string | null;
  tool_name: string | null;
  occurrence_count: number;
  status: string;
  sample_correlation_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
}): EngineeringWorkItem {
  const count = Number(row.occurrence_count ?? 0);
  return {
    id: `work_${row.cluster_key.slice(0, 48)}`,
    clusterKey: row.cluster_key,
    category: row.category,
    capability: row.capability,
    tool: row.tool_name,
    occurrenceCount: count,
    status: count >= 3 ? "work_item" : (row.status as EngineeringWorkItem["status"]),
    reproducible: count >= 3,
    autoDeploy: false,
    sampleCorrelationId: row.sample_correlation_id,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

export async function listEngineeringSupervisorFeed(
  db: D1Like,
  limit = 20,
): Promise<EngineeringWorkItem[]> {
  await db.prepare(ENSURE_CLUSTERS).run();
  const rows = await db
    .prepare(
      `SELECT cluster_key, category, capability, tool_name, occurrence_count, status, sample_correlation_id, first_seen_at, last_seen_at
       FROM engineering_failure_clusters
       ORDER BY occurrence_count DESC, last_seen_at DESC
       LIMIT ?`,
    )
    .bind(Math.min(50, Math.max(1, limit)))
    .all<{
      cluster_key: string;
      category: string;
      capability: string | null;
      tool_name: string | null;
      occurrence_count: number;
      status: string;
      sample_correlation_id: string | null;
      first_seen_at: string;
      last_seen_at: string;
    }>();
  return (rows.results ?? []).map(toWorkItem);
}

/**
 * Supervisor contract: cluster → reproduce → inspect → Cursor task → fix → tests →
 * regression → deploy guard → combined superstack → verify → mark resolved.
 * Never auto-deploy model-generated code from a single customer failure.
 */
export const ENGINEERING_SUPERVISOR_CONTRACT = {
  cursorInCustomerPath: false,
  autoDeployFromSingleFailure: false,
  requiredForFix: ["reproducibility", "tests", "deployment_guard", "regression", "safe_branch_from_production"] as const,
} as const;
