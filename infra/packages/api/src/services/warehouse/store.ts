/**
 * Tenant-scoped warehouse persistence.
 * D1 production backend + in-memory repository for tests.
 * company_id is always required. Cross-tenant reads return empty.
 */

import { newId, nowIso } from "../../db/mappers";
import {
  EMPTY_RECORD_COUNTS,
  type WarehouseCheckpoint,
  type WarehouseHealth,
  type WarehouseKpiSnapshot,
  type WarehouseRecordCounts,
  type WarehouseReconciliation,
  type WarehouseSource,
  type WarehouseSyncRun,
  type WarehouseSyncStatus,
  type WarehouseTrigger,
  type WarehouseXeroContact,
  type WarehouseXeroCreditNote,
  type WarehouseXeroInvoice,
  type WarehouseXeroInvoiceLine,
  type WarehouseXeroPayment,
} from "./standard";

export type WarehouseSnapshotRow = {
  companyId: string;
  connector: string;
  snapshotType: string;
  asOf: string;
  syncId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type WarehouseRepository = {
  ensureSchema(): Promise<void>;
  getSource(companyId: string, connector: string): Promise<WarehouseSource | null>;
  listSources(companyId: string): Promise<WarehouseSource[]>;
  upsertSource(source: WarehouseSource): Promise<void>;
  tryAcquireLock(input: {
    companyId: string;
    connector: string;
    owner: string;
    untilIso: string;
    nowIso: string;
  }): Promise<boolean>;
  releaseLock(companyId: string, connector: string, owner: string): Promise<void>;
  insertSyncRun(run: WarehouseSyncRun): Promise<void>;
  updateSyncRun(run: WarehouseSyncRun): Promise<void>;
  getSyncRun(companyId: string, syncId: string): Promise<WarehouseSyncRun | null>;
  findSyncBySlot(companyId: string, connector: string, scheduledFor: string): Promise<WarehouseSyncRun | null>;
  listRecentSyncs(companyId: string, connector: string, limit?: number): Promise<WarehouseSyncRun[]>;
  upsertInvoice(row: WarehouseXeroInvoice): Promise<"inserted" | "updated">;
  replaceInvoiceLines(companyId: string, invoiceId: string, lines: WarehouseXeroInvoiceLine[]): Promise<void>;
  upsertContact(row: WarehouseXeroContact): Promise<"inserted" | "updated">;
  upsertPayment(row: WarehouseXeroPayment): Promise<"inserted" | "updated">;
  upsertCreditNote(row: WarehouseXeroCreditNote): Promise<"inserted" | "updated">;
  listInvoices(companyId: string, filter?: InvoiceFilter): Promise<WarehouseXeroInvoice[]>;
  getInvoice(companyId: string, invoiceId: string): Promise<WarehouseXeroInvoice | null>;
  listInvoiceLines(companyId: string, invoiceId: string): Promise<WarehouseXeroInvoiceLine[]>;
  listContacts(companyId: string): Promise<WarehouseXeroContact[]>;
  listPayments(companyId: string, filter?: { fromDate?: string; toDate?: string }): Promise<WarehouseXeroPayment[]>;
  listCreditNotes(companyId: string, filter?: { fromDate?: string; toDate?: string }): Promise<WarehouseXeroCreditNote[]>;
  writeSnapshot(row: WarehouseSnapshotRow): Promise<void>;
  listSnapshots(companyId: string, connector: string, snapshotType: string): Promise<WarehouseSnapshotRow[]>;
  writeKpi(row: WarehouseKpiSnapshot): Promise<void>;
  latestKpi(companyId: string, connector: string): Promise<WarehouseKpiSnapshot | null>;
  countRecords(companyId: string, connector: string): Promise<WarehouseRecordCounts>;
};

export type InvoiceFilter = {
  fromDate?: string;
  toDate?: string;
  status?: string;
  contactId?: string;
  invoiceNumber?: string;
  currentOnly?: boolean;
};

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function sourceFromMemory(row: WarehouseSource): WarehouseSource {
  return { ...row, recordCounts: { ...row.recordCounts }, checkpoint: row.checkpoint ? { ...row.checkpoint } : null };
}

export function createMemoryWarehouseRepository(): WarehouseRepository {
  const sources = new Map<string, WarehouseSource>();
  const syncs = new Map<string, WarehouseSyncRun>();
  const invoices = new Map<string, WarehouseXeroInvoice>();
  const lines = new Map<string, WarehouseXeroInvoiceLine>();
  const contacts = new Map<string, WarehouseXeroContact>();
  const payments = new Map<string, WarehouseXeroPayment>();
  const creditNotes = new Map<string, WarehouseXeroCreditNote>();
  const snapshots: WarehouseSnapshotRow[] = [];
  const kpis: WarehouseKpiSnapshot[] = [];

  const sourceKey = (companyId: string, connector: string) => `${companyId}::${connector}`;
  const invoiceKey = (companyId: string, invoiceId: string) => `${companyId}::${invoiceId}`;
  const lineKey = (companyId: string, invoiceId: string, lineId: string) =>
    `${companyId}::${invoiceId}::${lineId}`;
  const contactKey = (companyId: string, contactId: string) => `${companyId}::${contactId}`;
  const paymentKey = (companyId: string, paymentId: string) => `${companyId}::${paymentId}`;
  const creditKey = (companyId: string, creditNoteId: string) => `${companyId}::${creditNoteId}`;

  return {
    async ensureSchema() {},
    async getSource(companyId, connector) {
      const found = sources.get(sourceKey(companyId, connector));
      return found ? sourceFromMemory(found) : null;
    },
    async listSources(companyId) {
      return [...sources.values()].filter((row) => row.companyId === companyId).map(sourceFromMemory);
    },
    async upsertSource(source) {
      sources.set(sourceKey(source.companyId, source.connector), sourceFromMemory(source));
    },
    async tryAcquireLock(input) {
      const key = sourceKey(input.companyId, input.connector);
      const current = sources.get(key);
      if (!current) return false;
      if (current.lockUntil && current.lockUntil > input.nowIso && current.lockOwner !== input.owner) {
        return false;
      }
      current.lockOwner = input.owner;
      current.lockUntil = input.untilIso;
      current.updatedAt = input.nowIso;
      return true;
    },
    async releaseLock(companyId, connector, owner) {
      const current = sources.get(sourceKey(companyId, connector));
      if (current && current.lockOwner === owner) {
        current.lockOwner = null;
        current.lockUntil = null;
        current.updatedAt = nowIso();
      }
    },
    async insertSyncRun(run) {
      syncs.set(run.syncId, { ...run });
    },
    async updateSyncRun(run) {
      syncs.set(run.syncId, { ...run });
    },
    async getSyncRun(companyId, syncId) {
      const run = syncs.get(syncId);
      return run && run.companyId === companyId ? { ...run } : null;
    },
    async findSyncBySlot(companyId, connector, scheduledFor) {
      return (
        [...syncs.values()].find(
          (run) =>
            run.companyId === companyId &&
            run.connector === connector &&
            run.scheduledFor === scheduledFor &&
            (run.status === "success" || run.status === "degraded" || run.status === "running"),
        ) ?? null
      );
    },
    async listRecentSyncs(companyId, connector, limit = 10) {
      return [...syncs.values()]
        .filter((run) => run.companyId === companyId && run.connector === connector)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, limit)
        .map((run) => ({ ...run }));
    },
    async upsertInvoice(row) {
      const key = invoiceKey(row.companyId, row.invoiceId);
      const existed = invoices.has(key);
      invoices.set(key, { ...row });
      return existed ? "updated" : "inserted";
    },
    async replaceInvoiceLines(companyId, invoiceId, nextLines) {
      for (const [key, row] of [...lines.entries()]) {
        if (row.companyId === companyId && row.invoiceId === invoiceId) lines.delete(key);
      }
      for (const line of nextLines) {
        lines.set(lineKey(line.companyId, line.invoiceId, line.lineId), { ...line });
      }
    },
    async upsertContact(row) {
      const key = contactKey(row.companyId, row.contactId);
      const existed = contacts.has(key);
      contacts.set(key, { ...row });
      return existed ? "updated" : "inserted";
    },
    async upsertPayment(row) {
      const key = paymentKey(row.companyId, row.paymentId);
      const existed = payments.has(key);
      payments.set(key, { ...row });
      return existed ? "updated" : "inserted";
    },
    async upsertCreditNote(row) {
      const key = creditKey(row.companyId, row.creditNoteId);
      const existed = creditNotes.has(key);
      creditNotes.set(key, { ...row });
      return existed ? "updated" : "inserted";
    },
    async listInvoices(companyId, filter) {
      return [...invoices.values()]
        .filter((row) => row.companyId === companyId)
        .filter((row) => (filter?.currentOnly === false ? true : row.isCurrent))
        .filter((row) => !filter?.status || row.status === filter.status)
        .filter((row) => !filter?.contactId || row.contactId === filter.contactId)
        .filter((row) => !filter?.invoiceNumber || row.invoiceNumber === filter.invoiceNumber)
        .filter((row) => !filter?.fromDate || (row.invoiceDate ?? "") >= filter.fromDate)
        .filter((row) => !filter?.toDate || (row.invoiceDate ?? "") <= filter.toDate);
    },
    async getInvoice(companyId, invoiceId) {
      const row = invoices.get(invoiceKey(companyId, invoiceId));
      return row && row.companyId === companyId ? { ...row } : null;
    },
    async listInvoiceLines(companyId, invoiceId) {
      return [...lines.values()].filter((row) => row.companyId === companyId && row.invoiceId === invoiceId);
    },
    async listContacts(companyId) {
      return [...contacts.values()].filter((row) => row.companyId === companyId);
    },
    async listPayments(companyId, filter) {
      return [...payments.values()]
        .filter((row) => row.companyId === companyId)
        .filter((row) => !filter?.fromDate || (row.paymentDate ?? "") >= filter.fromDate)
        .filter((row) => !filter?.toDate || (row.paymentDate ?? "") <= filter.toDate);
    },
    async listCreditNotes(companyId, filter) {
      return [...creditNotes.values()]
        .filter((row) => row.companyId === companyId)
        .filter((row) => !filter?.fromDate || (row.creditDate ?? "") >= filter.fromDate)
        .filter((row) => !filter?.toDate || (row.creditDate ?? "") <= filter.toDate);
    },
    async writeSnapshot(row) {
      const idx = snapshots.findIndex(
        (item) =>
          item.companyId === row.companyId &&
          item.connector === row.connector &&
          item.snapshotType === row.snapshotType &&
          item.asOf === row.asOf,
      );
      if (idx >= 0) snapshots[idx] = { ...row, payload: { ...row.payload } };
      else snapshots.push({ ...row, payload: { ...row.payload } });
    },
    async listSnapshots(companyId, connector, snapshotType) {
      return snapshots
        .filter(
          (row) =>
            row.companyId === companyId && row.connector === connector && row.snapshotType === snapshotType,
        )
        .sort((a, b) => a.asOf.localeCompare(b.asOf))
        .map((row) => ({ ...row, payload: { ...row.payload } }));
    },
    async writeKpi(row) {
      const idx = kpis.findIndex(
        (item) => item.companyId === row.companyId && item.connector === row.connector && item.asOf === row.asOf,
      );
      if (idx >= 0) kpis[idx] = { ...row };
      else kpis.push({ ...row });
    },
    async latestKpi(companyId, connector) {
      return (
        kpis
          .filter((row) => row.companyId === companyId && row.connector === connector)
          .sort((a, b) => b.asOf.localeCompare(a.asOf))[0] ?? null
      );
    },
    async countRecords(companyId) {
      return {
        invoices: [...invoices.values()].filter((row) => row.companyId === companyId).length,
        invoiceLines: [...lines.values()].filter((row) => row.companyId === companyId).length,
        contacts: [...contacts.values()].filter((row) => row.companyId === companyId).length,
        payments: [...payments.values()].filter((row) => row.companyId === companyId).length,
        creditNotes: [...creditNotes.values()].filter((row) => row.companyId === companyId).length,
        snapshots: snapshots.filter((row) => row.companyId === companyId).length,
      };
    },
  };
}

function mapSourceRow(row: Record<string, unknown>): WarehouseSource {
  return {
    companyId: String(row.company_id),
    connector: String(row.connector),
    status: String(row.status) as WarehouseHealth,
    lastSuccessfulSync: row.last_successful_sync ? String(row.last_successful_sync) : null,
    lastAttemptedSync: row.last_attempted_sync ? String(row.last_attempted_sync) : null,
    warehouseLastUpdatedAt: row.warehouse_last_updated_at ? String(row.warehouse_last_updated_at) : null,
    sourceLastUpdatedAt: row.source_last_updated_at ? String(row.source_last_updated_at) : null,
    syncStatus: row.sync_status ? String(row.sync_status) : null,
    checkpoint: parseJson<WarehouseCheckpoint | null>(row.checkpoint_json as string | null, null),
    historicalFrom: row.historical_from ? String(row.historical_from) : null,
    historicalTo: row.historical_to ? String(row.historical_to) : null,
    lastReconciliation: parseJson<WarehouseReconciliation | null>(
      row.last_reconciliation_json as string | null,
      null,
    ),
    lastFailureCode: row.last_failure_code ? String(row.last_failure_code) : null,
    recordCounts: parseJson<WarehouseRecordCounts>(row.record_counts_json as string | null, EMPTY_RECORD_COUNTS),
    lockOwner: row.lock_owner ? String(row.lock_owner) : null,
    lockUntil: row.lock_until ? String(row.lock_until) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapInvoiceRow(row: Record<string, unknown>): WarehouseXeroInvoice {
  return {
    companyId: String(row.company_id),
    invoiceId: String(row.invoice_id),
    invoiceNumber: row.invoice_number ? String(row.invoice_number) : null,
    type: row.type ? String(row.type) : null,
    contactId: row.contact_id ? String(row.contact_id) : null,
    contactName: row.contact_name ? String(row.contact_name) : null,
    status: row.status ? String(row.status) : null,
    invoiceDate: row.invoice_date ? String(row.invoice_date) : null,
    dueDate: row.due_date ? String(row.due_date) : null,
    reference: row.reference ? String(row.reference) : null,
    currency: row.currency ? String(row.currency) : null,
    subtotal: row.subtotal != null ? Number(row.subtotal) : null,
    tax: row.tax != null ? Number(row.tax) : null,
    total: row.total != null ? Number(row.total) : null,
    amountDue: row.amount_due != null ? Number(row.amount_due) : null,
    amountPaid: row.amount_paid != null ? Number(row.amount_paid) : null,
    amountCredited: row.amount_credited != null ? Number(row.amount_credited) : null,
    sourceUpdatedAt: row.source_updated_at ? String(row.source_updated_at) : null,
    warehouseUpdatedAt: String(row.warehouse_updated_at),
    isCurrent: Number(row.is_current) === 1,
  };
}

export function createD1WarehouseRepository(db: D1Database): WarehouseRepository {
  return {
    async ensureSchema() {
      // Tables are created by migration 0054. No-op keep-alive for callers.
    },
    async getSource(companyId, connector) {
      const row = await db
        .prepare(`SELECT * FROM warehouse_sources WHERE company_id = ? AND connector = ?`)
        .bind(companyId, connector)
        .first<Record<string, unknown>>();
      return row ? mapSourceRow(row) : null;
    },
    async listSources(companyId) {
      const rows = await db
        .prepare(`SELECT * FROM warehouse_sources WHERE company_id = ?`)
        .bind(companyId)
        .all<Record<string, unknown>>();
      return (rows.results ?? []).map(mapSourceRow);
    },
    async upsertSource(source) {
      await db
        .prepare(
          `INSERT INTO warehouse_sources (
            company_id, connector, status, last_successful_sync, last_attempted_sync,
            warehouse_last_updated_at, source_last_updated_at, sync_status, checkpoint_json,
            historical_from, historical_to, last_reconciliation_json, last_failure_code,
            record_counts_json, lock_owner, lock_until, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(company_id, connector) DO UPDATE SET
            status = excluded.status,
            last_successful_sync = excluded.last_successful_sync,
            last_attempted_sync = excluded.last_attempted_sync,
            warehouse_last_updated_at = excluded.warehouse_last_updated_at,
            source_last_updated_at = excluded.source_last_updated_at,
            sync_status = excluded.sync_status,
            checkpoint_json = excluded.checkpoint_json,
            historical_from = excluded.historical_from,
            historical_to = excluded.historical_to,
            last_reconciliation_json = excluded.last_reconciliation_json,
            last_failure_code = excluded.last_failure_code,
            record_counts_json = excluded.record_counts_json,
            lock_owner = excluded.lock_owner,
            lock_until = excluded.lock_until,
            updated_at = excluded.updated_at`,
        )
        .bind(
          source.companyId,
          source.connector,
          source.status,
          source.lastSuccessfulSync,
          source.lastAttemptedSync,
          source.warehouseLastUpdatedAt,
          source.sourceLastUpdatedAt,
          source.syncStatus,
          source.checkpoint ? JSON.stringify(source.checkpoint) : null,
          source.historicalFrom,
          source.historicalTo,
          source.lastReconciliation ? JSON.stringify(source.lastReconciliation) : null,
          source.lastFailureCode,
          JSON.stringify(source.recordCounts),
          source.lockOwner,
          source.lockUntil,
          source.createdAt,
          source.updatedAt,
        )
        .run();
    },
    async tryAcquireLock(input) {
      const result = await db
        .prepare(
          `UPDATE warehouse_sources
           SET lock_owner = ?, lock_until = ?, updated_at = ?
           WHERE company_id = ? AND connector = ?
             AND (lock_until IS NULL OR lock_until <= ? OR lock_owner = ?)`,
        )
        .bind(
          input.owner,
          input.untilIso,
          input.nowIso,
          input.companyId,
          input.connector,
          input.nowIso,
          input.owner,
        )
        .run();
      return (result.meta.changes ?? 0) > 0;
    },
    async releaseLock(companyId, connector, owner) {
      await db
        .prepare(
          `UPDATE warehouse_sources
           SET lock_owner = NULL, lock_until = NULL, updated_at = ?
           WHERE company_id = ? AND connector = ? AND lock_owner = ?`,
        )
        .bind(nowIso(), companyId, connector, owner)
        .run();
    },
    async insertSyncRun(run) {
      await db
        .prepare(
          `INSERT INTO warehouse_sync_runs (
            sync_id, company_id, connector, trigger, scheduled_for, started_at, completed_at,
            checkpoint_before, checkpoint_after, records_read, records_inserted, records_updated,
            snapshots_written, status, failure_code, latency_ms, reconciliation_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          run.syncId,
          run.companyId,
          run.connector,
          run.trigger,
          run.scheduledFor,
          run.startedAt,
          run.completedAt,
          run.checkpointBefore,
          run.checkpointAfter,
          run.recordsRead,
          run.recordsInserted,
          run.recordsUpdated,
          run.snapshotsWritten,
          run.status,
          run.failureCode,
          run.latencyMs,
          run.reconciliation ? JSON.stringify(run.reconciliation) : null,
          run.startedAt,
        )
        .run();
    },
    async updateSyncRun(run) {
      await db
        .prepare(
          `UPDATE warehouse_sync_runs SET
            completed_at = ?, checkpoint_after = ?, records_read = ?, records_inserted = ?,
            records_updated = ?, snapshots_written = ?, status = ?, failure_code = ?,
            latency_ms = ?, reconciliation_json = ?
           WHERE sync_id = ? AND company_id = ?`,
        )
        .bind(
          run.completedAt,
          run.checkpointAfter,
          run.recordsRead,
          run.recordsInserted,
          run.recordsUpdated,
          run.snapshotsWritten,
          run.status,
          run.failureCode,
          run.latencyMs,
          run.reconciliation ? JSON.stringify(run.reconciliation) : null,
          run.syncId,
          run.companyId,
        )
        .run();
    },
    async getSyncRun(companyId, syncId) {
      const row = await db
        .prepare(`SELECT * FROM warehouse_sync_runs WHERE sync_id = ? AND company_id = ?`)
        .bind(syncId, companyId)
        .first<Record<string, unknown>>();
      if (!row) return null;
      return {
        syncId: String(row.sync_id),
        companyId: String(row.company_id),
        connector: String(row.connector),
        trigger: String(row.trigger) as WarehouseTrigger,
        scheduledFor: row.scheduled_for ? String(row.scheduled_for) : null,
        startedAt: String(row.started_at),
        completedAt: row.completed_at ? String(row.completed_at) : null,
        checkpointBefore: row.checkpoint_before ? String(row.checkpoint_before) : null,
        checkpointAfter: row.checkpoint_after ? String(row.checkpoint_after) : null,
        recordsRead: Number(row.records_read ?? 0),
        recordsInserted: Number(row.records_inserted ?? 0),
        recordsUpdated: Number(row.records_updated ?? 0),
        snapshotsWritten: Number(row.snapshots_written ?? 0),
        status: String(row.status) as WarehouseSyncStatus,
        failureCode: row.failure_code ? String(row.failure_code) : null,
        latencyMs: row.latency_ms != null ? Number(row.latency_ms) : null,
        reconciliation: parseJson(row.reconciliation_json as string | null, null),
      };
    },
    async findSyncBySlot(companyId, connector, scheduledFor) {
      const row = await db
        .prepare(
          `SELECT * FROM warehouse_sync_runs
           WHERE company_id = ? AND connector = ? AND scheduled_for = ?
             AND status IN ('success', 'degraded', 'running')
           ORDER BY started_at DESC LIMIT 1`,
        )
        .bind(companyId, connector, scheduledFor)
        .first<Record<string, unknown>>();
      if (!row) return null;
      return this.getSyncRun(companyId, String(row.sync_id));
    },
    async listRecentSyncs(companyId, connector, limit = 10) {
      const rows = await db
        .prepare(
          `SELECT sync_id FROM warehouse_sync_runs
           WHERE company_id = ? AND connector = ?
           ORDER BY started_at DESC LIMIT ?`,
        )
        .bind(companyId, connector, limit)
        .all<{ sync_id: string }>();
      const out: WarehouseSyncRun[] = [];
      for (const row of rows.results ?? []) {
        const run = await this.getSyncRun(companyId, row.sync_id);
        if (run) out.push(run);
      }
      return out;
    },
    async upsertInvoice(row) {
      const existing = await db
        .prepare(`SELECT invoice_id FROM warehouse_xero_invoices WHERE company_id = ? AND invoice_id = ?`)
        .bind(row.companyId, row.invoiceId)
        .first();
      await db
        .prepare(
          `INSERT INTO warehouse_xero_invoices (
            company_id, invoice_id, invoice_number, type, contact_id, contact_name, status,
            invoice_date, due_date, reference, currency, subtotal, tax, total, amount_due,
            amount_paid, amount_credited, source_updated_at, warehouse_updated_at, is_current
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(company_id, invoice_id) DO UPDATE SET
            invoice_number = excluded.invoice_number,
            type = excluded.type,
            contact_id = excluded.contact_id,
            contact_name = excluded.contact_name,
            status = excluded.status,
            invoice_date = excluded.invoice_date,
            due_date = excluded.due_date,
            reference = excluded.reference,
            currency = excluded.currency,
            subtotal = excluded.subtotal,
            tax = excluded.tax,
            total = excluded.total,
            amount_due = excluded.amount_due,
            amount_paid = excluded.amount_paid,
            amount_credited = excluded.amount_credited,
            source_updated_at = excluded.source_updated_at,
            warehouse_updated_at = excluded.warehouse_updated_at,
            is_current = excluded.is_current`,
        )
        .bind(
          row.companyId,
          row.invoiceId,
          row.invoiceNumber,
          row.type,
          row.contactId,
          row.contactName,
          row.status,
          row.invoiceDate,
          row.dueDate,
          row.reference,
          row.currency,
          row.subtotal,
          row.tax,
          row.total,
          row.amountDue,
          row.amountPaid,
          row.amountCredited,
          row.sourceUpdatedAt,
          row.warehouseUpdatedAt,
          row.isCurrent ? 1 : 0,
        )
        .run();
      return existing ? "updated" : "inserted";
    },
    async replaceInvoiceLines(companyId, invoiceId, nextLines) {
      await db
        .prepare(`DELETE FROM warehouse_xero_invoice_lines WHERE company_id = ? AND invoice_id = ?`)
        .bind(companyId, invoiceId)
        .run();
      for (const line of nextLines) {
        await db
          .prepare(
            `INSERT INTO warehouse_xero_invoice_lines (
              company_id, invoice_id, line_id, description, quantity, unit_amount, tax,
              line_total, account_code, warehouse_updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            line.companyId,
            line.invoiceId,
            line.lineId,
            line.description,
            line.quantity,
            line.unitAmount,
            line.tax,
            line.lineTotal,
            line.accountCode,
            line.warehouseUpdatedAt,
          )
          .run();
      }
    },
    async upsertContact(row) {
      const existing = await db
        .prepare(`SELECT contact_id FROM warehouse_xero_contacts WHERE company_id = ? AND contact_id = ?`)
        .bind(row.companyId, row.contactId)
        .first();
      await db
        .prepare(
          `INSERT INTO warehouse_xero_contacts (
            company_id, contact_id, display_name, status, is_customer, is_supplier,
            account_number, source_updated_at, warehouse_updated_at, is_current
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(company_id, contact_id) DO UPDATE SET
            display_name = excluded.display_name,
            status = excluded.status,
            is_customer = excluded.is_customer,
            is_supplier = excluded.is_supplier,
            account_number = excluded.account_number,
            source_updated_at = excluded.source_updated_at,
            warehouse_updated_at = excluded.warehouse_updated_at,
            is_current = excluded.is_current`,
        )
        .bind(
          row.companyId,
          row.contactId,
          row.displayName,
          row.status,
          row.isCustomer == null ? null : row.isCustomer ? 1 : 0,
          row.isSupplier == null ? null : row.isSupplier ? 1 : 0,
          row.accountNumber,
          row.sourceUpdatedAt,
          row.warehouseUpdatedAt,
          row.isCurrent ? 1 : 0,
        )
        .run();
      return existing ? "updated" : "inserted";
    },
    async upsertPayment(row) {
      const existing = await db
        .prepare(`SELECT payment_id FROM warehouse_xero_payments WHERE company_id = ? AND payment_id = ?`)
        .bind(row.companyId, row.paymentId)
        .first();
      await db
        .prepare(
          `INSERT INTO warehouse_xero_payments (
            company_id, payment_id, invoice_id, payment_date, amount, status, payment_type,
            reference, source_updated_at, warehouse_updated_at, is_current
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(company_id, payment_id) DO UPDATE SET
            invoice_id = excluded.invoice_id,
            payment_date = excluded.payment_date,
            amount = excluded.amount,
            status = excluded.status,
            payment_type = excluded.payment_type,
            reference = excluded.reference,
            source_updated_at = excluded.source_updated_at,
            warehouse_updated_at = excluded.warehouse_updated_at,
            is_current = excluded.is_current`,
        )
        .bind(
          row.companyId,
          row.paymentId,
          row.invoiceId,
          row.paymentDate,
          row.amount,
          row.status,
          row.paymentType,
          row.reference,
          row.sourceUpdatedAt,
          row.warehouseUpdatedAt,
          row.isCurrent ? 1 : 0,
        )
        .run();
      return existing ? "updated" : "inserted";
    },
    async upsertCreditNote(row) {
      const existing = await db
        .prepare(
          `SELECT credit_note_id FROM warehouse_xero_credit_notes WHERE company_id = ? AND credit_note_id = ?`,
        )
        .bind(row.companyId, row.creditNoteId)
        .first();
      await db
        .prepare(
          `INSERT INTO warehouse_xero_credit_notes (
            company_id, credit_note_id, credit_note_number, type, contact_id, contact_name,
            status, credit_date, reference, currency, subtotal, tax, total, remaining_credit,
            source_updated_at, warehouse_updated_at, is_current
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(company_id, credit_note_id) DO UPDATE SET
            credit_note_number = excluded.credit_note_number,
            type = excluded.type,
            contact_id = excluded.contact_id,
            contact_name = excluded.contact_name,
            status = excluded.status,
            credit_date = excluded.credit_date,
            reference = excluded.reference,
            currency = excluded.currency,
            subtotal = excluded.subtotal,
            tax = excluded.tax,
            total = excluded.total,
            remaining_credit = excluded.remaining_credit,
            source_updated_at = excluded.source_updated_at,
            warehouse_updated_at = excluded.warehouse_updated_at,
            is_current = excluded.is_current`,
        )
        .bind(
          row.companyId,
          row.creditNoteId,
          row.creditNoteNumber,
          row.type,
          row.contactId,
          row.contactName,
          row.status,
          row.creditDate,
          row.reference,
          row.currency,
          row.subtotal,
          row.tax,
          row.total,
          row.remainingCredit,
          row.sourceUpdatedAt,
          row.warehouseUpdatedAt,
          row.isCurrent ? 1 : 0,
        )
        .run();
      return existing ? "updated" : "inserted";
    },
    async listInvoices(companyId, filter) {
      const clauses = ["company_id = ?"];
      const binds: unknown[] = [companyId];
      if (filter?.currentOnly !== false) {
        clauses.push("is_current = 1");
      }
      if (filter?.status) {
        clauses.push("status = ?");
        binds.push(filter.status);
      }
      if (filter?.contactId) {
        clauses.push("contact_id = ?");
        binds.push(filter.contactId);
      }
      if (filter?.invoiceNumber) {
        clauses.push("invoice_number = ?");
        binds.push(filter.invoiceNumber);
      }
      if (filter?.fromDate) {
        clauses.push("invoice_date >= ?");
        binds.push(filter.fromDate);
      }
      if (filter?.toDate) {
        clauses.push("invoice_date <= ?");
        binds.push(filter.toDate);
      }
      const rows = await db
        .prepare(`SELECT * FROM warehouse_xero_invoices WHERE ${clauses.join(" AND ")}`)
        .bind(...binds)
        .all<Record<string, unknown>>();
      return (rows.results ?? []).map(mapInvoiceRow);
    },
    async getInvoice(companyId, invoiceId) {
      const row = await db
        .prepare(`SELECT * FROM warehouse_xero_invoices WHERE company_id = ? AND invoice_id = ?`)
        .bind(companyId, invoiceId)
        .first<Record<string, unknown>>();
      return row ? mapInvoiceRow(row) : null;
    },
    async listInvoiceLines(companyId, invoiceId) {
      const rows = await db
        .prepare(`SELECT * FROM warehouse_xero_invoice_lines WHERE company_id = ? AND invoice_id = ?`)
        .bind(companyId, invoiceId)
        .all<Record<string, unknown>>();
      return (rows.results ?? []).map((row) => ({
        companyId: String(row.company_id),
        invoiceId: String(row.invoice_id),
        lineId: String(row.line_id),
        description: row.description ? String(row.description) : null,
        quantity: row.quantity != null ? Number(row.quantity) : null,
        unitAmount: row.unit_amount != null ? Number(row.unit_amount) : null,
        tax: row.tax != null ? Number(row.tax) : null,
        lineTotal: row.line_total != null ? Number(row.line_total) : null,
        accountCode: row.account_code ? String(row.account_code) : null,
        warehouseUpdatedAt: String(row.warehouse_updated_at),
      }));
    },
    async listContacts(companyId) {
      const rows = await db
        .prepare(`SELECT * FROM warehouse_xero_contacts WHERE company_id = ?`)
        .bind(companyId)
        .all<Record<string, unknown>>();
      return (rows.results ?? []).map((row) => ({
        companyId: String(row.company_id),
        contactId: String(row.contact_id),
        displayName: row.display_name ? String(row.display_name) : null,
        status: row.status ? String(row.status) : null,
        isCustomer: row.is_customer == null ? null : Number(row.is_customer) === 1,
        isSupplier: row.is_supplier == null ? null : Number(row.is_supplier) === 1,
        accountNumber: row.account_number ? String(row.account_number) : null,
        sourceUpdatedAt: row.source_updated_at ? String(row.source_updated_at) : null,
        warehouseUpdatedAt: String(row.warehouse_updated_at),
        isCurrent: Number(row.is_current) === 1,
      }));
    },
    async listPayments(companyId, filter) {
      const clauses = ["company_id = ?"];
      const binds: unknown[] = [companyId];
      if (filter?.fromDate) {
        clauses.push("payment_date >= ?");
        binds.push(filter.fromDate);
      }
      if (filter?.toDate) {
        clauses.push("payment_date <= ?");
        binds.push(filter.toDate);
      }
      const rows = await db
        .prepare(`SELECT * FROM warehouse_xero_payments WHERE ${clauses.join(" AND ")}`)
        .bind(...binds)
        .all<Record<string, unknown>>();
      return (rows.results ?? []).map((row) => ({
        companyId: String(row.company_id),
        paymentId: String(row.payment_id),
        invoiceId: row.invoice_id ? String(row.invoice_id) : null,
        paymentDate: row.payment_date ? String(row.payment_date) : null,
        amount: row.amount != null ? Number(row.amount) : null,
        status: row.status ? String(row.status) : null,
        paymentType: row.payment_type ? String(row.payment_type) : null,
        reference: row.reference ? String(row.reference) : null,
        sourceUpdatedAt: row.source_updated_at ? String(row.source_updated_at) : null,
        warehouseUpdatedAt: String(row.warehouse_updated_at),
        isCurrent: Number(row.is_current) === 1,
      }));
    },
    async listCreditNotes(companyId, filter) {
      const clauses = ["company_id = ?"];
      const binds: unknown[] = [companyId];
      if (filter?.fromDate) {
        clauses.push("credit_date >= ?");
        binds.push(filter.fromDate);
      }
      if (filter?.toDate) {
        clauses.push("credit_date <= ?");
        binds.push(filter.toDate);
      }
      const rows = await db
        .prepare(`SELECT * FROM warehouse_xero_credit_notes WHERE ${clauses.join(" AND ")}`)
        .bind(...binds)
        .all<Record<string, unknown>>();
      return (rows.results ?? []).map((row) => ({
        companyId: String(row.company_id),
        creditNoteId: String(row.credit_note_id),
        creditNoteNumber: row.credit_note_number ? String(row.credit_note_number) : null,
        type: row.type ? String(row.type) : null,
        contactId: row.contact_id ? String(row.contact_id) : null,
        contactName: row.contact_name ? String(row.contact_name) : null,
        status: row.status ? String(row.status) : null,
        creditDate: row.credit_date ? String(row.credit_date) : null,
        reference: row.reference ? String(row.reference) : null,
        currency: row.currency ? String(row.currency) : null,
        subtotal: row.subtotal != null ? Number(row.subtotal) : null,
        tax: row.tax != null ? Number(row.tax) : null,
        total: row.total != null ? Number(row.total) : null,
        remainingCredit: row.remaining_credit != null ? Number(row.remaining_credit) : null,
        sourceUpdatedAt: row.source_updated_at ? String(row.source_updated_at) : null,
        warehouseUpdatedAt: String(row.warehouse_updated_at),
        isCurrent: Number(row.is_current) === 1,
      }));
    },
    async writeSnapshot(row) {
      await db
        .prepare(
          `INSERT INTO warehouse_snapshots (
            company_id, connector, snapshot_type, as_of, sync_id, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(company_id, connector, snapshot_type, as_of) DO UPDATE SET
            sync_id = excluded.sync_id,
            payload_json = excluded.payload_json`,
        )
        .bind(
          row.companyId,
          row.connector,
          row.snapshotType,
          row.asOf,
          row.syncId,
          JSON.stringify(row.payload),
          row.createdAt,
        )
        .run();
    },
    async listSnapshots(companyId, connector, snapshotType) {
      const rows = await db
        .prepare(
          `SELECT * FROM warehouse_snapshots
           WHERE company_id = ? AND connector = ? AND snapshot_type = ?
           ORDER BY as_of ASC`,
        )
        .bind(companyId, connector, snapshotType)
        .all<Record<string, unknown>>();
      return (rows.results ?? []).map((row) => ({
        companyId: String(row.company_id),
        connector: String(row.connector),
        snapshotType: String(row.snapshot_type),
        asOf: String(row.as_of),
        syncId: row.sync_id ? String(row.sync_id) : null,
        payload: parseJson(row.payload_json as string | null, {}),
        createdAt: String(row.created_at),
      }));
    },
    async writeKpi(row) {
      await db
        .prepare(
          `INSERT INTO warehouse_kpi_snapshots (
            company_id, connector, as_of, sync_id, sales_mtd, sales_today, invoice_count_mtd,
            outstanding_receivables, overdue_receivables, overdue_invoice_count, paid_amount_mtd,
            top_customers_json, currency, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(company_id, connector, as_of) DO UPDATE SET
            sync_id = excluded.sync_id,
            sales_mtd = excluded.sales_mtd,
            sales_today = excluded.sales_today,
            invoice_count_mtd = excluded.invoice_count_mtd,
            outstanding_receivables = excluded.outstanding_receivables,
            overdue_receivables = excluded.overdue_receivables,
            overdue_invoice_count = excluded.overdue_invoice_count,
            paid_amount_mtd = excluded.paid_amount_mtd,
            top_customers_json = excluded.top_customers_json,
            currency = excluded.currency`,
        )
        .bind(
          row.companyId,
          row.connector,
          row.asOf,
          row.syncId,
          row.salesMtd,
          row.salesToday,
          row.invoiceCountMtd,
          row.outstandingReceivables,
          row.overdueReceivables,
          row.overdueInvoiceCount,
          row.paidAmountMtd,
          JSON.stringify(row.topCustomers),
          row.currency,
          row.createdAt,
        )
        .run();
    },
    async latestKpi(companyId, connector) {
      const row = await db
        .prepare(
          `SELECT * FROM warehouse_kpi_snapshots
           WHERE company_id = ? AND connector = ?
           ORDER BY as_of DESC LIMIT 1`,
        )
        .bind(companyId, connector)
        .first<Record<string, unknown>>();
      if (!row) return null;
      return {
        companyId: String(row.company_id),
        connector: String(row.connector),
        asOf: String(row.as_of),
        syncId: row.sync_id ? String(row.sync_id) : null,
        salesMtd: Number(row.sales_mtd ?? 0),
        salesToday: Number(row.sales_today ?? 0),
        invoiceCountMtd: Number(row.invoice_count_mtd ?? 0),
        outstandingReceivables: Number(row.outstanding_receivables ?? 0),
        overdueReceivables: Number(row.overdue_receivables ?? 0),
        overdueInvoiceCount: Number(row.overdue_invoice_count ?? 0),
        paidAmountMtd: Number(row.paid_amount_mtd ?? 0),
        topCustomers: parseJson(row.top_customers_json as string | null, []),
        currency: row.currency ? String(row.currency) : null,
        createdAt: String(row.created_at),
      };
    },
    async countRecords(companyId) {
      const [invoices, invoiceLines, contacts, payments, creditNotes, snaps] = await Promise.all([
        db.prepare(`SELECT COUNT(*) AS n FROM warehouse_xero_invoices WHERE company_id = ?`).bind(companyId).first<{ n: number }>(),
        db.prepare(`SELECT COUNT(*) AS n FROM warehouse_xero_invoice_lines WHERE company_id = ?`).bind(companyId).first<{ n: number }>(),
        db.prepare(`SELECT COUNT(*) AS n FROM warehouse_xero_contacts WHERE company_id = ?`).bind(companyId).first<{ n: number }>(),
        db.prepare(`SELECT COUNT(*) AS n FROM warehouse_xero_payments WHERE company_id = ?`).bind(companyId).first<{ n: number }>(),
        db.prepare(`SELECT COUNT(*) AS n FROM warehouse_xero_credit_notes WHERE company_id = ?`).bind(companyId).first<{ n: number }>(),
        db.prepare(`SELECT COUNT(*) AS n FROM warehouse_snapshots WHERE company_id = ?`).bind(companyId).first<{ n: number }>(),
      ]);
      return {
        invoices: Number(invoices?.n ?? 0),
        invoiceLines: Number(invoiceLines?.n ?? 0),
        contacts: Number(contacts?.n ?? 0),
        payments: Number(payments?.n ?? 0),
        creditNotes: Number(creditNotes?.n ?? 0),
        snapshots: Number(snaps?.n ?? 0),
      };
    },
  };
}

export function newWarehouseSource(input: {
  companyId: string;
  connector: string;
  now?: string;
}): WarehouseSource {
  const now = input.now ?? nowIso();
  return {
    companyId: input.companyId,
    connector: input.connector,
    status: "NEVER_SYNCED",
    lastSuccessfulSync: null,
    lastAttemptedSync: null,
    warehouseLastUpdatedAt: null,
    sourceLastUpdatedAt: null,
    syncStatus: null,
    checkpoint: null,
    historicalFrom: null,
    historicalTo: null,
    lastReconciliation: null,
    lastFailureCode: null,
    recordCounts: { ...EMPTY_RECORD_COUNTS },
    lockOwner: null,
    lockUntil: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function newSyncId(): string {
  return newId("whsync");
}
