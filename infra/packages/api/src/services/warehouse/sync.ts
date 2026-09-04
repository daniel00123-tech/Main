/**
 * Warehouse sync orchestrator — lock, incremental extract, snapshots, reconcile.
 * Deterministic. No OpenAI. AUTOMATION traffic. One lock per company+connector.
 */

import { nowIso } from "../../db/mappers";
import { recordUsageEvent } from "../usage";
import type { Env } from "../../env";
import { persistWarehouseFailure } from "./telemetry";
import {
  EMPTY_RECORD_COUNTS,
  WAREHOUSE_EL_COMPANY_ID,
  WAREHOUSE_LOCK_TTL_MS,
  WAREHOUSE_RECONCILE_ABS_TOLERANCE,
  WAREHOUSE_XERO_CONNECTOR,
  deriveWarehouseHealth,
  type WarehouseHealth,
  type WarehouseKpiSnapshot,
  type WarehouseSource,
  type WarehouseSyncRun,
  type WarehouseTrigger,
} from "./standard";
import { recountMonthRecords, summariseCompleteness } from "./windows";
import { sendWarehouseBackfillCompleteEmail } from "./email";
import { computeNextWarehouseSyncUtcIso, currentWarehouseSlot, warehouseScheduleIdempotencyKey } from "./schedule";
import {
  createD1WarehouseRepository,
  newSyncId,
  newWarehouseSource,
  type WarehouseRepository,
} from "./store";
import { createXeroWarehouseAdapter, computeWarehouseSalesMetrics, londonDateParts } from "./adapters/xero";
import { buildReconciliation, type WarehouseConnectorAdapter } from "./adapters/types";

export type WarehouseSyncResult = {
  ran: boolean;
  skipped?: "locked" | "not_due" | "duplicate_slot";
  run?: WarehouseSyncRun;
  source?: WarehouseSource;
};

export async function ensureWarehouseSource(
  repo: WarehouseRepository,
  companyId: string,
  connector: string,
): Promise<WarehouseSource> {
  const existing = await repo.getSource(companyId, connector);
  if (existing) return existing;
  const created = newWarehouseSource({ companyId, connector });
  await repo.upsertSource(created);
  return created;
}

export async function runWarehouseSync(input: {
  repo: WarehouseRepository;
  adapter: WarehouseConnectorAdapter;
  companyId: string;
  connector?: string;
  trigger: WarehouseTrigger;
  scheduledFor?: string | null;
  now?: Date;
  env?: Env;
}): Promise<WarehouseSyncResult> {
  const now = input.now ?? new Date();
  const connector = input.connector ?? input.adapter.connector;
  const source = await ensureWarehouseSource(input.repo, input.companyId, connector);
  const owner = newSyncId();
  const locked = await input.repo.tryAcquireLock({
    companyId: input.companyId,
    connector,
    owner,
    untilIso: new Date(now.getTime() + WAREHOUSE_LOCK_TTL_MS).toISOString(),
    nowIso: now.toISOString(),
  });
  if (!locked) {
    const skipped: WarehouseSyncRun = {
      syncId: newSyncId(),
      companyId: input.companyId,
      connector,
      trigger: input.trigger,
      scheduledFor: input.scheduledFor ?? null,
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
      checkpointBefore: source.checkpoint ? JSON.stringify(source.checkpoint) : null,
      checkpointAfter: source.checkpoint ? JSON.stringify(source.checkpoint) : null,
      recordsRead: 0,
      recordsInserted: 0,
      recordsUpdated: 0,
      snapshotsWritten: 0,
      status: "skipped_locked",
      failureCode: "WAREHOUSE_LOCKED",
      latencyMs: 0,
      reconciliation: null,
    };
    await input.repo.insertSyncRun(skipped);
    return { ran: false, skipped: "locked", run: skipped, source };
  }

  const run: WarehouseSyncRun = {
    syncId: owner,
    companyId: input.companyId,
    connector,
    trigger: input.trigger,
    scheduledFor: input.scheduledFor ?? null,
    startedAt: now.toISOString(),
    completedAt: null,
    checkpointBefore: source.checkpoint ? JSON.stringify(source.checkpoint) : null,
    checkpointAfter: null,
    recordsRead: 0,
    recordsInserted: 0,
    recordsUpdated: 0,
    snapshotsWritten: 0,
    status: "running",
    failureCode: null,
    latencyMs: null,
    reconciliation: null,
  };
  await input.repo.insertSyncRun(run);
  source.lastAttemptedSync = now.toISOString();
  source.syncStatus = "running";
  source.lockOwner = owner;
  source.lockUntil = new Date(now.getTime() + WAREHOUSE_LOCK_TTL_MS).toISOString();
  source.updatedAt = now.toISOString();
  await input.repo.upsertSource(source);

  try {
    const storedInvoices = await input.repo.listInvoices(input.companyId, { currentOnly: false });
    const extract = await input.adapter.extract({
      companyId: input.companyId,
      checkpoint: source.checkpoint,
      now,
      trigger: input.trigger === "backfill" ? "backfill" : input.trigger,
      storedInvoices,
    });
    run.recordsRead = extract.recordsRead;
    for (const invoice of extract.invoices) {
      const result = await input.repo.upsertInvoice(invoice);
      if (result === "inserted") run.recordsInserted += 1;
      else run.recordsUpdated += 1;
    }
    const linesByInvoice = new Map<string, typeof extract.invoiceLines>();
    for (const line of extract.invoiceLines) {
      const list = linesByInvoice.get(line.invoiceId) ?? [];
      list.push(line);
      linesByInvoice.set(line.invoiceId, list);
    }
    for (const [invoiceId, lines] of linesByInvoice) {
      await input.repo.replaceInvoiceLines(input.companyId, invoiceId, lines);
    }
    for (const contact of extract.contacts) {
      const result = await input.repo.upsertContact(contact);
      if (result === "inserted") run.recordsInserted += 1;
      else run.recordsUpdated += 1;
    }
    for (const payment of extract.payments) {
      const result = await input.repo.upsertPayment(payment);
      if (result === "inserted") run.recordsInserted += 1;
      else run.recordsUpdated += 1;
    }
    for (const note of extract.creditNotes) {
      const result = await input.repo.upsertCreditNote(note);
      if (result === "inserted") run.recordsInserted += 1;
      else run.recordsUpdated += 1;
    }

    const invoices = await input.repo.listInvoices(input.companyId, { currentOnly: false });
    const creditNotes = await input.repo.listCreditNotes(input.companyId);
    const dates = londonDateParts(now);
    const metrics = computeWarehouseSalesMetrics(invoices, creditNotes, dates);
    const asOf = now.toISOString();
    const persistedInvoices = await input.repo.listInvoices(input.companyId, { currentOnly: false });
    const months = recountMonthRecords(extract.checkpoint.months ?? [], persistedInvoices);
    const completeness = extract.checkpoint.completeness ?? summariseCompleteness(months);
    extract.checkpoint.months = months;
    extract.checkpoint.completeness = completeness;
    extract.checkpoint.recordsRetrieved = persistedInvoices.length;
    extract.checkpoint.historicalComplete = completeness === "COMPLETE";

    await input.repo.writeSnapshot({
      companyId: input.companyId,
      connector,
      snapshotType: "xero_sales_snapshot",
      asOf,
      syncId: run.syncId,
      payload: {
        salesMtd: metrics.salesMtd,
        salesToday: metrics.salesToday,
        invoiceCountMtd: metrics.invoiceCountMtd,
        completeness,
      },
      createdAt: asOf,
    });
    await input.repo.writeSnapshot({
      companyId: input.companyId,
      connector,
      snapshotType: "xero_receivables_snapshot",
      asOf,
      syncId: run.syncId,
      payload: { outstanding: metrics.outstanding, completeness },
      createdAt: asOf,
    });
    await input.repo.writeSnapshot({
      companyId: input.companyId,
      connector,
      snapshotType: "xero_overdue_snapshot",
      asOf,
      syncId: run.syncId,
      payload: { overdue: metrics.overdue, overdueCount: metrics.overdueCount, completeness },
      createdAt: asOf,
    });
    await input.repo.writeSnapshot({
      companyId: input.companyId,
      connector,
      snapshotType: "xero_customer_snapshot",
      asOf,
      syncId: run.syncId,
      payload: { topCustomers: metrics.topCustomers, completeness },
      createdAt: asOf,
    });
    const kpi: WarehouseKpiSnapshot = {
      companyId: input.companyId,
      connector,
      asOf,
      syncId: run.syncId,
      salesMtd: metrics.salesMtd,
      salesToday: metrics.salesToday,
      invoiceCountMtd: metrics.invoiceCountMtd,
      outstandingReceivables: metrics.outstanding,
      overdueReceivables: metrics.overdue,
      overdueInvoiceCount: metrics.overdueCount,
      paidAmountMtd: metrics.paidMtd,
      topCustomers: metrics.topCustomers,
      currency: extract.organisation?.currency ?? "GBP",
      createdAt: asOf,
    };
    await input.repo.writeKpi(kpi);
    run.snapshotsWritten = 5;

    const live = input.adapter.liveTotals
      ? await input.adapter.liveTotals({ companyId: input.companyId, now })
      : {
          mtdSales: metrics.salesMtd,
          invoiceCount: metrics.invoiceCountMtd,
          outstanding: metrics.outstanding,
          overdue: metrics.overdue,
        };
    const reconciliation = buildReconciliation({
      warehouse: {
        mtdSales: metrics.salesMtd,
        invoiceCount: metrics.invoiceCountMtd,
        outstanding: metrics.outstanding,
        overdue: metrics.overdue,
      },
      live,
      comparedAt: asOf,
      tolerance: WAREHOUSE_RECONCILE_ABS_TOLERANCE,
    });
    run.reconciliation = reconciliation;
    const counts = await input.repo.countRecords(input.companyId, connector);
    const health: WarehouseHealth = deriveWarehouseHealth({
      completeness,
      reconcilePassed: reconciliation.passed,
      liveUnavailable: live.unavailable,
    });
    run.status = health === "DEGRADED" || health === "FAILED" ? "degraded" : "success";
    run.failureCode = health === "DEGRADED"
      ? live.unavailable
        ? "WAREHOUSE_XERO_UNAVAILABLE"
        : "WAREHOUSE_RECONCILIATION_FAILED"
      : null;
    run.checkpointAfter = JSON.stringify(extract.checkpoint);
    run.completedAt = new Date().toISOString();
    run.latencyMs = Date.now() - now.getTime();
    await input.repo.updateSyncRun(run);

    const next: WarehouseSource = {
      ...source,
      status: health,
      lastSuccessfulSync: asOf,
      lastAttemptedSync: asOf,
      warehouseLastUpdatedAt: asOf,
      sourceLastUpdatedAt: extract.checkpoint.sourceTimestamp ?? asOf,
      syncStatus: run.status,
      checkpoint: extract.checkpoint,
      historicalFrom: extract.checkpoint.historyFrom ?? source.historicalFrom,
      historicalTo: extract.checkpoint.historyTo ?? source.historicalTo,
      lastReconciliation: reconciliation,
      lastFailureCode: run.failureCode,
      recordCounts: counts,
      lockOwner: null,
      lockUntil: null,
      updatedAt: asOf,
    };
    await input.repo.upsertSource(next);
    if (
      completeness === "COMPLETE" &&
      !extract.checkpoint.completionEmailSent &&
      input.env
    ) {
      const emailed = await sendWarehouseBackfillCompleteEmail(input.env, {
        source: next,
        run,
      });
      if (emailed.sent) {
        next.checkpoint = { ...extract.checkpoint, completionEmailSent: true };
        await input.repo.upsertSource(next);
      }
    }
    if (health === "DEGRADED" && input.env) {
      await persistWarehouseFailure(input.env, {
        companyId: input.companyId,
        category: run.failureCode ?? "WAREHOUSE_RECONCILIATION_FAILED",
        tool: "warehouse_sync",
        detail: { divergence: reconciliation.divergence, truncated: extract.truncated },
      });
    }
    if (input.env) {
      await recordUsageEvent(input.env.DB, {
        companyId: input.companyId,
        actorEmail: "system:warehouse",
        resourceType: "warehouse",
        resourceId: run.syncId,
        toolName: "warehouse_sync",
        action: "warehouse.sync",
        success: true,
        durationMs: run.latencyMs ?? 0,
        sourceClient: "automation",
        metadata: {
          trafficClass: "AUTOMATION",
          customerChargeCents: 0,
          connector,
          trigger: input.trigger,
        },
        customerChargeCents: 0,
      });
    }
    return { ran: true, run, source: next };
  } catch (err) {
    const message = err instanceof Error ? err.message : "warehouse sync failed";
    const code = (err as { code?: string }).code ?? "WAREHOUSE_SYNC_FAILED";
    run.status = "failed";
    run.failureCode = code;
    run.completedAt = new Date().toISOString();
    run.latencyMs = Date.now() - now.getTime();
    await input.repo.updateSyncRun(run);
    source.status = source.lastSuccessfulSync ? "FAILED" : "FAILED";
    source.syncStatus = "failed";
    source.lastFailureCode = code;
    source.lastAttemptedSync = now.toISOString();
    source.lockOwner = null;
    source.lockUntil = null;
    source.updatedAt = now.toISOString();
    await input.repo.upsertSource(source);
    if (input.env) {
      await persistWarehouseFailure(input.env, {
        companyId: input.companyId,
        category: "WAREHOUSE_SYNC_FAILED",
        tool: "warehouse_sync",
        detail: { message, code },
      });
    }
    return { ran: true, run, source };
  } finally {
    await input.repo.releaseLock(input.companyId, connector, owner);
  }
}

export async function maybeRunWarehouseSyncs(
  env: Env,
  now = new Date(),
): Promise<{
  actions: Array<{ companyId: string; skipped?: string; syncId?: string; status?: string }>;
  nextSync: string;
}> {
  const repo = createD1WarehouseRepository(env.DB);
  const source = await ensureWarehouseSource(repo, WAREHOUSE_EL_COMPANY_ID, WAREHOUSE_XERO_CONNECTOR);
  const slot = currentWarehouseSlot(now);
  const nextSync = computeNextWarehouseSyncUtcIso(now);
  if (!slot && source.status !== "NEVER_SYNCED") return { actions: [], nextSync };

  if (slot) {
    const existing = await repo.findSyncBySlot(WAREHOUSE_EL_COMPANY_ID, WAREHOUSE_XERO_CONNECTOR, slot.utcIso);
    if (existing) {
      return {
        actions: [{ companyId: WAREHOUSE_EL_COMPANY_ID, skipped: "duplicate_slot", syncId: existing.syncId }],
        nextSync,
      };
    }
  }

  const adapter = createXeroWarehouseAdapter(env);
  const result = await runWarehouseSync({
    repo,
    adapter,
    companyId: WAREHOUSE_EL_COMPANY_ID,
    connector: WAREHOUSE_XERO_CONNECTOR,
    trigger: source.status === "NEVER_SYNCED" || source.status === "FAILED" ? "backfill" : "scheduled",
    scheduledFor: slot?.utcIso ?? null,
    now,
    env,
  });
  void warehouseScheduleIdempotencyKey;
  return {
    actions: [
      {
        companyId: WAREHOUSE_EL_COMPANY_ID,
        skipped: result.skipped,
        syncId: result.run?.syncId,
        status: result.run?.status,
      },
    ],
    nextSync,
  };
}

export async function continueWarehouseSync(input: {
  env: Env;
  companyId?: string;
  now?: Date;
  repo?: WarehouseRepository;
  adapter?: WarehouseConnectorAdapter;
}): Promise<WarehouseSyncResult> {
  const companyId = input.companyId ?? WAREHOUSE_EL_COMPANY_ID;
  const repo = input.repo ?? createD1WarehouseRepository(input.env.DB);
  const adapter = input.adapter ?? createXeroWarehouseAdapter(input.env);
  const source = await ensureWarehouseSource(repo, companyId, adapter.connector);
  return runWarehouseSync({
    repo,
    adapter,
    companyId,
    connector: adapter.connector,
    trigger: source.checkpoint?.mode === "backfill" ? "backfill" : "manual",
    now: input.now,
    env: input.env,
  });
}

export async function runWarehouseBackfill(input: {
  env: Env;
  companyId?: string;
  now?: Date;
  repo?: WarehouseRepository;
  adapter?: WarehouseConnectorAdapter;
}): Promise<WarehouseSyncResult> {
  const companyId = input.companyId ?? WAREHOUSE_EL_COMPANY_ID;
  const repo = input.repo ?? createD1WarehouseRepository(input.env.DB);
  const adapter = input.adapter ?? createXeroWarehouseAdapter(input.env);
  const source = await ensureWarehouseSource(repo, companyId, adapter.connector);
  source.checkpoint = null;
  await repo.upsertSource(source);
  return runWarehouseSync({
    repo,
    adapter,
    companyId,
    connector: adapter.connector,
    trigger: "backfill",
    now: input.now,
    env: input.env,
  });
}

export function emptyCounts() {
  return { ...EMPTY_RECORD_COUNTS };
}
