import type { Ai } from "@cloudflare/workers-types";
import { MCP_VERSION } from "./constants";
import { log } from "./logger";

export interface Env {
  CADDINGTON_BUSINESS_DATA: D1Database;
  CADDINGTON_KNOWLEDGE?: R2Bucket;
  CADDINGTON_KNOWLEDGE_INDEX?: VectorizeIndex;
  AI: Ai;
  MCP_AUTH_TOKEN?: string;
  CADDINGTON_ADMIN_TOKEN?: string;
  /** JSON: { client_id, client_secret, refresh_token } — Drive readonly scope only. */
  GOOGLE_DRIVE_CREDENTIALS?: string;
}

export interface DbHealth {
  connected: boolean;
  latencyMs?: number;
  error?: string;
}

export interface StorageHealth {
  available: boolean;
  latencyMs?: number;
  error?: string;
}

export interface VectorizeHealth {
  available: boolean;
  latencyMs?: number;
  error?: string;
}

export interface TableSummary {
  name: string;
  recordCount: number;
  latestTimestamp: string | null;
}

export async function checkDatabaseHealth(db: D1Database): Promise<DbHealth> {
  const start = Date.now();
  try {
    await db.prepare("SELECT 1 AS ok").first();
    return { connected: true, latencyMs: Date.now() - start };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("error", "d1_health_failed", { error: message });
    return { connected: false, error: message };
  }
}

export async function checkR2Health(bucket?: R2Bucket): Promise<StorageHealth> {
  if (!bucket) {
    return {
      available: false,
      error: "R2 binding not configured or bucket not provisioned.",
    };
  }
  const start = Date.now();
  try {
    await bucket.head(".__caddington_health_probe");
    return { available: true, latencyMs: Date.now() - start };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Missing probe object is OK — bucket is reachable
    if (message.includes("Not Found") || message.includes("404")) {
      return { available: true, latencyMs: Date.now() - start };
    }
    log("warn", "r2_health_failed", { error: message });
    return { available: false, error: message };
  }
}

export async function checkVectorizeHealth(
  index?: VectorizeIndex
): Promise<VectorizeHealth> {
  if (!index) {
    return {
      available: false,
      error: "Vectorize binding not configured or index not provisioned.",
    };
  }
  const start = Date.now();
  try {
    await index.describe();
    return { available: true, latencyMs: Date.now() - start };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("warn", "vectorize_health_failed", { error: message });
    return { available: false, error: message };
  }
}

export async function getDatabaseSummary(db: D1Database): Promise<TableSummary[]> {
  const { SUMMARY_TABLES, SUMMARY_TIMESTAMP_COLUMNS } = await import(
    "./constants"
  );
  const summaries: TableSummary[] = [];

  for (const name of SUMMARY_TABLES) {
    const countRow = await db
      .prepare(`SELECT COUNT(*) AS count FROM ${name}`)
      .first<{ count: number }>();
    const recordCount = countRow?.count ?? 0;

    const tsColumn = SUMMARY_TIMESTAMP_COLUMNS[name];
    let latestTimestamp: string | null = null;
    if (tsColumn) {
      const tsRow = await db
        .prepare(`SELECT MAX(${tsColumn}) AS latest FROM ${name}`)
        .first<{ latest: string | null }>();
      latestTimestamp = tsRow?.latest ?? null;
    }

    summaries.push({ name, recordCount, latestTimestamp });
  }

  return summaries;
}

export async function runReadOnlyQuery(
  db: D1Database,
  sql: string
): Promise<{
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}> {
  const result = await db.prepare(sql).all();
  const columns =
    result.results.length > 0
      ? Object.keys(result.results[0] as Record<string, unknown>)
      : [];
  return {
    columns,
    rows: result.results as Record<string, unknown>[],
    rowCount: result.results.length,
  };
}

export async function recordSystemHealthLog(
  env: Env,
  payload: {
    overallStatus: string;
    d1: DbHealth;
    r2: StorageHealth;
    vectorize: VectorizeHealth;
  }
): Promise<void> {
  try {
    await env.CADDINGTON_BUSINESS_DATA.prepare(
      `INSERT INTO system_health_log (overall_status, mcp_version, d1_status, r2_status, vectorize_status, details)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        payload.overallStatus,
        MCP_VERSION,
        payload.d1.connected ? "healthy" : "unhealthy",
        payload.r2.available ? "healthy" : "unhealthy",
        payload.vectorize.available ? "healthy" : "unhealthy",
        JSON.stringify({
          d1: payload.d1,
          r2: payload.r2,
          vectorize: payload.vectorize,
        })
      )
      .run();
  } catch (error) {
    log("warn", "system_health_log_write_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
