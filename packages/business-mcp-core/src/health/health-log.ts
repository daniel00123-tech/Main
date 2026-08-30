import type { DbHealth, StorageHealth, VectorizeHealth } from "../types/health";
import type { Logger } from "../logging/logger";

export interface HealthLogPayload {
  overallStatus: string;
  mcpVersion: string;
  d1: DbHealth;
  r2: StorageHealth;
  vectorize: VectorizeHealth;
}

export async function recordSystemHealthLog(
  db: D1Database,
  payload: HealthLogPayload,
  logger?: Logger
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO system_health_log (overall_status, mcp_version, d1_status, r2_status, vectorize_status, details)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        payload.overallStatus,
        payload.mcpVersion,
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
    logger?.warn("system_health_log_write_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
