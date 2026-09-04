/**
 * Generic warehouse vs live-source freshness policy.
 * Concepts, not phrase patches. Uncertain → truthful freshness, do not invent.
 */

import {
  WAREHOUSE_FRESH_ENOUGH_MS,
  WAREHOUSE_STALE_AFTER_MS,
  warehouseHealthIsServable,
  type WarehouseCompleteness,
  type WarehouseEvidence,
  type WarehouseFreshnessClass,
  type WarehouseHealth,
} from "./standard";

export function classifyQueryFreshness(text: string): WarehouseFreshnessClass {
  const value = String(text ?? "").trim();
  if (!value) return "UNCERTAIN";

  const currentLive =
    /\b(right now|just now|this (second|minute)|has .* been paid( yet)?|paid yet|newest invoice|latest invoice|current status of invoice|invoice \S+ (status|paid))\b/i.test(
      value,
    ) ||
    /\bwhat are (sales|revenue) right now\b/i.test(value) ||
    /\b(is|has) invoice\b.+\b(paid|voided|authorised|outstanding)\b/i.test(value);

  const historical =
    /\b(each month|month by month|over time|trend|trends|last (six|6|three|3|twelve|12) months|last year|this quarter|same point last|compare .+ (month|quarter|year)|highest-value customers over|proportion of invoiced|end of each month|historical|over this period)\b/i.test(
      value,
    ) ||
    /\bhow has (overdue|outstanding|debt|sales) (moved|changed|changed over)\b/i.test(value);

  const currentButMaybeFresh =
    /\b(this month|mtd|month to date|sales today|current mtd)\b/i.test(value) &&
    !currentLive &&
    !historical;

  if (currentLive && !historical) return "CURRENT_LIVE_STATE";
  if (historical && !currentLive) return "HISTORICAL_ANALYTICAL";
  if (currentButMaybeFresh) return "CURRENT_BUT_WAREHOUSE_FRESH_ENOUGH";
  if (currentLive && historical) return "UNCERTAIN";
  return "UNCERTAIN";
}

export function warehouseIsStale(lastSuccessfulSync: string | null | undefined, now = Date.now()): boolean {
  if (!lastSuccessfulSync) return true;
  const parsed = Date.parse(lastSuccessfulSync);
  if (Number.isNaN(parsed)) return true;
  return now - parsed > WAREHOUSE_STALE_AFTER_MS;
}

export function warehouseIsFreshEnough(
  lastSuccessfulSync: string | null | undefined,
  now = Date.now(),
): boolean {
  if (!lastSuccessfulSync) return false;
  const parsed = Date.parse(lastSuccessfulSync);
  if (Number.isNaN(parsed)) return false;
  return now - parsed <= WAREHOUSE_FRESH_ENOUGH_MS;
}

export function preferredSource(input: {
  freshnessClass: WarehouseFreshnessClass;
  health: WarehouseHealth;
  lastSuccessfulSync?: string | null;
  now?: number;
}): "warehouse" | "live" | "explain" {
  const now = input.now ?? Date.now();
  if (input.health === "FAILED" || input.health === "NEVER_SYNCED" || input.health === "DEGRADED") {
    return input.freshnessClass === "HISTORICAL_ANALYTICAL" && input.health === "DEGRADED"
      ? "explain"
      : "live";
  }
  if (!warehouseHealthIsServable(input.health) && input.health !== "HEALTHY") {
    return "live";
  }
  if (warehouseIsStale(input.lastSuccessfulSync, now) && input.freshnessClass !== "HISTORICAL_ANALYTICAL") {
    return "live";
  }
  if (input.freshnessClass === "HISTORICAL_ANALYTICAL") return "warehouse";
  if (input.freshnessClass === "CURRENT_LIVE_STATE") return "live";
  if (input.freshnessClass === "CURRENT_BUT_WAREHOUSE_FRESH_ENOUGH") {
    return warehouseIsFreshEnough(input.lastSuccessfulSync, now) ? "warehouse" : "live";
  }
  return "explain";
}

export function canServeWarehouse(input: {
  health: WarehouseHealth;
  lastSuccessfulSync?: string | null;
  freshnessClass: WarehouseFreshnessClass;
  now?: number;
}): { serve: boolean; reason: string } {
  if (input.health === "NEVER_SYNCED") {
    return { serve: false, reason: "WAREHOUSE_NEVER_SYNCED" };
  }
  if (input.health === "FAILED") {
    return { serve: false, reason: "WAREHOUSE_SYNC_FAILED" };
  }
  if (input.health === "DEGRADED") {
    return { serve: false, reason: "WAREHOUSE_RECONCILIATION_FAILED" };
  }
  if (!warehouseHealthIsServable(input.health)) {
    return { serve: false, reason: "WAREHOUSE_QUERY_FAILED" };
  }
  if (
    warehouseIsStale(input.lastSuccessfulSync, input.now) &&
    input.freshnessClass !== "HISTORICAL_ANALYTICAL"
  ) {
    return { serve: false, reason: "WAREHOUSE_STALE" };
  }
  return { serve: true, reason: "WAREHOUSE_OK" };
}

export function buildWarehouseEvidence(input: {
  companyId: string;
  connector: string;
  health: WarehouseHealth;
  warehouseAsOf: string | null;
  freshnessClass: WarehouseFreshnessClass;
  completenessStatus?: WarehouseCompleteness;
  source?: WarehouseEvidence["source"];
}): WarehouseEvidence {
  const completenessStatus =
    input.completenessStatus ??
    (input.health === "HEALTHY" || input.health === "COMPLETE"
      ? "COMPLETE"
      : input.health === "BACKFILLING"
        ? "BACKFILLING"
        : input.health === "PARTIAL"
          ? "PARTIAL"
          : input.health === "FAILED"
            ? "FAILED"
            : input.health === "DEGRADED"
              ? "DEGRADED"
              : "NEVER_SYNCED");
  return {
    source: input.source ?? "xero_warehouse",
    warehouseAsOf: input.warehouseAsOf,
    freshnessClass: input.freshnessClass,
    health: input.health,
    completenessStatus,
    companyId: input.companyId,
    connector: input.connector,
  };
}
