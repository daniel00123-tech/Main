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
  return {
    companyId,
    connector: WAREHOUSE_XERO_CONNECTOR,
    label: "Xero Warehouse",
    status: source?.status ?? "NEVER_SYNCED",
    lastSuccessfulSync: source?.lastSuccessfulSync ?? null,
    nextScheduledSync: computeNextWarehouseSyncUtcIso(),
    records: source?.recordCounts ?? null,
    historicalRange: {
      from: source?.historicalFrom ?? null,
      to: source?.historicalTo ?? null,
    },
    latestReconciliation: source?.lastReconciliation ?? null,
    latestKpi: kpi,
    failures: recent.filter((run) => run.status === "failed" || run.status === "degraded"),
    recentSyncs: recent,
    schedule: describeWarehouseSchedule(),
    warehouseLastUpdatedAt: source?.warehouseLastUpdatedAt ?? null,
    sourceLastUpdatedAt: source?.sourceLastUpdatedAt ?? null,
  };
}
