import { persistEngineeringFailures } from "../intelligence/dev-failure-queue";
import type { EngineeringFailureCategory, EngineeringFailureEvent } from "../intelligence/types";
import type { Env } from "../../env";
import { newId, nowIso } from "../../db/mappers";

const WAREHOUSE_CATEGORIES = new Set([
  "WAREHOUSE_SYNC_FAILED",
  "WAREHOUSE_STALE",
  "WAREHOUSE_RECONCILIATION_FAILED",
  "WAREHOUSE_QUERY_FAILED",
  "WAREHOUSE_SOURCE_DIVERGENCE",
]);

export async function persistWarehouseFailure(
  env: Env,
  input: {
    companyId: string;
    category: string;
    tool?: string | null;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  const category = WAREHOUSE_CATEGORIES.has(input.category)
    ? input.category
    : "WAREHOUSE_SYNC_FAILED";
  const event: EngineeringFailureEvent = {
    id: newId("whfail"),
    correlationId: newId("wh"),
    companyId: input.companyId,
    channel: "internal",
    capability: "warehouse",
    tool: input.tool ?? "warehouse_sync",
    model: null,
    provider: null,
    category: category as EngineeringFailureCategory,
    latencyMs: 0,
    outcome: "failed",
    metadata: input.detail ?? {},
    createdAt: nowIso(),
  };
  await persistEngineeringFailures(env.DB, [event]);
}
