import { computeNextWarehouseSyncUtcIso, describeWarehouseSchedule } from "./schedule";
import type { WarehouseRepository } from "./store";
import { WAREHOUSE_XERO_CONNECTOR } from "./standard";

export async function warehouseControlCentreView(
  repo: WarehouseRepository,
  companyId: string,
) {
  const source = await repo.getSource(companyId, WAREHOUSE_XERO_CONNECTOR);
  const recent = source ? await repo.listRecentSyncs(companyId, WAREHOUSE_XERO_CONNECTOR, 5) : [];
  const kpi = source ? await repo.latestKpi(companyId, WAREHOUSE_XERO_CONNECTOR) : null;
  const months = source?.checkpoint?.months ?? [];
  const monthsComplete = months.filter((row) => row.status === "COMPLETE").map((row) => row.month);
  const monthsPartial = months.filter((row) => row.status !== "COMPLETE").map((row) => ({
    month: row.month,
    status: row.status,
    recordsRetrieved: row.recordsRetrieved,
    nextWindowFrom: row.nextWindowFrom ?? null,
  }));
  const completeness = source?.checkpoint?.completeness ?? source?.status ?? "NEVER_SYNCED";
  const displayStatus =
    source?.status === "DEGRADED" || source?.status === "FAILED"
      ? source.status
      : completeness;
  const lastBatch = recent.find((run) => run.status === "success" || run.status === "degraded") ?? null;
  return {
    companyId,
    connector: WAREHOUSE_XERO_CONNECTOR,
    label: "Xero Warehouse",
    status: displayStatus,
    completeness,
    health: source?.status ?? "NEVER_SYNCED",
    lastSuccessfulSync: source?.lastSuccessfulSync ?? null,
    lastSuccessfulBatch: lastBatch
      ? {
          syncId: lastBatch.syncId,
          completedAt: lastBatch.completedAt,
          recordsRead: lastBatch.recordsRead,
          recordsUpserted: lastBatch.recordsInserted + lastBatch.recordsUpdated,
        }
      : null,
    nextScheduledSync: computeNextWarehouseSyncUtcIso(),
    records: source?.recordCounts ?? null,
    historicalRange: {
      from: source?.historicalFrom ?? null,
      to: source?.historicalTo ?? null,
    },
    monthsComplete,
    monthsPartial,
    remainingWindows: source?.checkpoint?.remainingWindows ?? null,
    remainingWorkEstimate:
      source?.checkpoint?.remainingWindows != null
        ? `${source.checkpoint.remainingWindows} bounded windows remaining (50 records/call; no calendar ETA)`
        : null,
    contactsStatus: source?.checkpoint?.contactsStatus ?? null,
    contactPage: source?.checkpoint?.contactPage ?? null,
    invoiceLinesStatus: source?.checkpoint?.invoiceLinesStatus ?? null,
    paymentsStatus: source?.checkpoint?.paymentsStatus ?? null,
    creditNotesStatus: source?.checkpoint?.creditNotesStatus ?? null,
    latestReconciliation: source?.lastReconciliation ?? null,
    latestKpi: kpi,
    failures: recent.filter((run) => run.status === "failed" || run.status === "degraded"),
    recentSyncs: recent,
    schedule: describeWarehouseSchedule(),
    warehouseLastUpdatedAt: source?.warehouseLastUpdatedAt ?? null,
    sourceLastUpdatedAt: source?.sourceLastUpdatedAt ?? null,
    checkpoint: source?.checkpoint
      ? {
          backfillCursor: source.checkpoint.backfillCursor ?? null,
          windowGrain: source.checkpoint.windowGrain ?? null,
          lastCompletedWindow: source.checkpoint.lastCompletedWindow ?? null,
          lastAttemptedWindow: source.checkpoint.lastAttemptedWindow ?? null,
        }
      : null,
  };
}
