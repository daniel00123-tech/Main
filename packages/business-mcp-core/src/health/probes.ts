import { R2_HEALTH_PROBE_KEY } from "../version";
import type { DbHealth, StorageHealth, VectorizeHealth } from "../types/health";
import type { Logger } from "../logging/logger";

export async function checkDatabaseHealth(
  db: D1Database,
  logger?: Logger
): Promise<DbHealth> {
  const start = Date.now();
  try {
    await db.prepare("SELECT 1 AS ok").first();
    return { connected: true, latencyMs: Date.now() - start };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.error("d1_health_failed", { error: message });
    return { connected: false, error: message };
  }
}

export async function checkR2Health(
  bucket: R2Bucket | undefined,
  logger?: Logger,
  probeKey = R2_HEALTH_PROBE_KEY
): Promise<StorageHealth> {
  if (!bucket) {
    return {
      available: false,
      error: "R2 binding not configured or bucket not provisioned.",
    };
  }
  const start = Date.now();
  try {
    await bucket.head(probeKey);
    return { available: true, latencyMs: Date.now() - start };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Not Found") || message.includes("404")) {
      return { available: true, latencyMs: Date.now() - start };
    }
    logger?.warn("r2_health_failed", { error: message });
    return { available: false, error: message };
  }
}

export async function checkVectorizeHealth(
  index: VectorizeIndex | undefined,
  logger?: Logger
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
    logger?.warn("vectorize_health_failed", { error: message });
    return { available: false, error: message };
  }
}

export function computeOverallHealth(
  components: Array<{ healthy: boolean }>
): "healthy" | "degraded" | "unhealthy" {
  const healthyCount = components.filter((c) => c.healthy).length;
  if (healthyCount === components.length) return "healthy";
  if (healthyCount > 0) return "degraded";
  return "unhealthy";
}
