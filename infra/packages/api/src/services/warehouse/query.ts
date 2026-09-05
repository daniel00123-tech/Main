/**
 * Bounded warehouse query builder.
 * No arbitrary SQL. Tenant is always taken from the authorised companyId.
 */

import { londonDateParts } from "./adapters/xero";
import { computeWarehouseSalesMetrics } from "./adapters/xero";
import { buildWarehouseEvidence, canServeWarehouse, classifyWarehouseRequest } from "./freshness";
import type { WarehouseRepository } from "./store";
import {
  WAREHOUSE_XERO_CONNECTOR,
  warehouseChildDebitCents,
  type WarehouseCompleteness,
  type WarehouseFreshnessClass,
  type WarehouseHealth,
} from "./standard";
import { rangeCompleteness } from "./windows";

export const WAREHOUSE_AGGREGATIONS = [
  "sales_by_month",
  "sales_total",
  "invoice_count",
  "outstanding_total",
  "overdue_total",
  "top_customers",
  "kpi_latest",
  "snapshot_series",
  "invoice_list",
] as const;
export type WarehouseAggregation = (typeof WAREHOUSE_AGGREGATIONS)[number];

export type WarehouseQueryRequest = {
  companyId: string;
  connector?: string;
  entity?: "invoices" | "invoice_lines" | "contacts" | "payments" | "credit_notes" | "snapshots" | "kpis";
  aggregation?: WarehouseAggregation;
  fromDate?: string;
  toDate?: string;
  status?: string;
  contactId?: string;
  invoiceNumber?: string;
  snapshotType?: string;
  limit?: number;
  intentText?: string;
  freshnessClass?: WarehouseFreshnessClass;
};

export type WarehouseQueryResult = {
  ok: boolean;
  fallback?: "xero_live";
  reason?: string;
  suggestedTool?: string;
  customerChargeCents: 0;
  evidence: ReturnType<typeof buildWarehouseEvidence>;
  result?: Record<string, unknown>;
};

function monthKey(date: string | null): string | null {
  return date && /^\d{4}-\d{2}/.test(date) ? date.slice(0, 7) : null;
}

export function validateWarehouseQuery(input: WarehouseQueryRequest): { ok: true } | { ok: false; error: string } {
  if (!input.companyId) return { ok: false, error: "company_id required" };
  if (input.connector && input.connector !== WAREHOUSE_XERO_CONNECTOR && /[;'"]|drop |insert |update |delete /i.test(input.connector)) {
    return { ok: false, error: "invalid connector" };
  }
  if (input.aggregation && !(WAREHOUSE_AGGREGATIONS as readonly string[]).includes(input.aggregation)) {
    return { ok: false, error: "aggregation not approved" };
  }
  if (input.fromDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.fromDate)) return { ok: false, error: "invalid fromDate" };
  if (input.toDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.toDate)) return { ok: false, error: "invalid toDate" };
  if (typeof input.limit === "number" && (input.limit < 1 || input.limit > 100)) {
    return { ok: false, error: "limit must be 1-100" };
  }
  return { ok: true };
}

export async function executeWarehouseQuery(
  repo: WarehouseRepository,
  input: WarehouseQueryRequest,
  now = new Date(),
): Promise<WarehouseQueryResult> {
  const validated = validateWarehouseQuery(input);
  const freshnessClass =
    input.freshnessClass ??
    classifyWarehouseRequest({
      intentText: input.intentText,
      fromDate: input.fromDate,
      toDate: input.toDate,
    });
  const source = await repo.getSource(input.companyId, input.connector ?? WAREHOUSE_XERO_CONNECTOR);
  const health: WarehouseHealth = source?.status ?? "NEVER_SYNCED";
  const warehouseAsOf = source?.warehouseLastUpdatedAt ?? source?.lastSuccessfulSync ?? null;
  const completenessStatus: WarehouseCompleteness =
    source?.checkpoint?.completeness ??
    (health === "HEALTHY" || health === "COMPLETE"
      ? "COMPLETE"
      : health === "BACKFILLING"
        ? "BACKFILLING"
        : health === "PARTIAL"
          ? "PARTIAL"
          : health === "FAILED"
            ? "FAILED"
            : health === "DEGRADED"
              ? "DEGRADED"
              : "NEVER_SYNCED");
  const evidence = buildWarehouseEvidence({
    companyId: input.companyId,
    connector: input.connector ?? WAREHOUSE_XERO_CONNECTOR,
    health,
    warehouseAsOf,
    freshnessClass,
    completenessStatus,
  });
  if (!validated.ok) {
    return {
      ok: false,
      reason: "WAREHOUSE_QUERY_FAILED",
      customerChargeCents: warehouseChildDebitCents(),
      evidence,
      result: { error: validated.error },
    };
  }
  const serve = canServeWarehouse({
    health,
    lastSuccessfulSync: source?.lastSuccessfulSync,
    freshnessClass,
  });
  if (!serve.serve) {
    return {
      ok: false,
      fallback: "xero_live",
      reason: serve.reason,
      suggestedTool:
        freshnessClass === "CURRENT_LIVE_STATE" ? "xero_sales_summary" : "xero_sales_summary",
      customerChargeCents: warehouseChildDebitCents(),
      evidence,
    };
  }

  const dates = londonDateParts(now);
  const fromDate = input.fromDate ?? source?.historicalFrom ?? dates.monthStart;
  const toDate = input.toDate ?? dates.today;
  const aggregation = input.aggregation ?? defaultAggregation(input);
  const invoices = await repo.listInvoices(input.companyId, {
    fromDate,
    toDate,
    status: input.status,
    contactId: input.contactId,
    invoiceNumber: input.invoiceNumber,
    currentOnly: true,
  });
  const creditNotes = await repo.listCreditNotes(input.companyId, { fromDate, toDate });
  const metrics = computeWarehouseSalesMetrics(invoices, creditNotes, {
    today: toDate,
    monthStart: fromDate,
  });
  const outstandingInvoices = await repo.listInvoices(input.companyId, { currentOnly: true });
  const outstandingMetrics = computeWarehouseSalesMetrics(outstandingInvoices, [], {
    today: dates.today,
    monthStart: dates.monthStart,
  });

  const months = source?.checkpoint?.months ?? [];
  const rangeStatus = months.length ? rangeCompleteness(months, fromDate, toDate) : completenessStatus;
  const partialRange = rangeStatus === "PARTIAL" || rangeStatus === "BACKFILLING" || rangeStatus === "NEVER_SYNCED";
  const monthStatusByKey = new Map(months.map((row) => [row.month, row.status]));

  let payload: Record<string, unknown> = {};
  switch (aggregation) {
    case "sales_by_month": {
      const buckets = new Map<
        string,
        { month: string; sales: number; invoiceCount: number; completeness: string }
      >();
      for (const invoice of invoices) {
        const key = monthKey(invoice.invoiceDate);
        if (!key || invoice.type !== "ACCREC" || !invoice.isCurrent) continue;
        if (invoice.status === "VOIDED" || invoice.status === "DELETED" || invoice.status === "DRAFT") continue;
        const bucket = buckets.get(key) ?? {
          month: key,
          sales: 0,
          invoiceCount: 0,
          completeness: monthStatusByKey.get(key) ?? rangeStatus,
        };
        bucket.sales += invoice.total ?? 0;
        bucket.invoiceCount += 1;
        buckets.set(key, bucket);
      }
      for (const note of creditNotes) {
        const key = monthKey(note.creditDate);
        if (!key || note.type !== "ACCRECCREDIT" || !note.isCurrent) continue;
        const bucket = buckets.get(key) ?? {
          month: key,
          sales: 0,
          invoiceCount: 0,
          completeness: monthStatusByKey.get(key) ?? rangeStatus,
        };
        bucket.sales -= Math.abs(note.total ?? 0);
        buckets.set(key, bucket);
      }
      payload = { months: [...buckets.values()].sort((a, b) => a.month.localeCompare(b.month)) };
      break;
    }
    case "sales_total":
      payload = { sales: metrics.salesMtd, fromDate, toDate, currency: source?.lastReconciliation ? undefined : "GBP" };
      break;
    case "invoice_count":
      payload = { invoiceCount: metrics.invoiceCountMtd, fromDate, toDate };
      break;
    case "outstanding_total":
      payload = { outstanding: outstandingMetrics.outstanding, asOf: dates.today };
      break;
    case "overdue_total":
      payload = {
        overdue: outstandingMetrics.overdue,
        overdueCount: outstandingMetrics.overdueCount,
        asOf: dates.today,
      };
      break;
    case "top_customers": {
      const contacts = await repo.listContacts(input.companyId).catch(() => []);
      const byId = new Map(contacts.map((row) => [row.contactId, row.displayName ?? null]));
      payload = {
        customers: metrics.topCustomers.map((row) => ({
          ...row,
          name:
            row.name ||
            (row.contactId ? byId.get(row.contactId) : null) ||
            null,
        })),
        fromDate,
        toDate,
      };
      break;
    }
    case "kpi_latest":
      payload = { kpi: await repo.latestKpi(input.companyId, input.connector ?? WAREHOUSE_XERO_CONNECTOR) };
      break;
    case "snapshot_series": {
      const type = input.snapshotType ?? "xero_overdue_snapshot";
      payload = {
        snapshots: await repo.listSnapshots(input.companyId, input.connector ?? WAREHOUSE_XERO_CONNECTOR, type),
      };
      break;
    }
    case "invoice_list":
      payload = {
        invoices: invoices.slice(0, input.limit ?? 25).map((row) => ({
          invoiceId: row.invoiceId,
          invoiceNumber: row.invoiceNumber,
          contactName: row.contactName,
          status: row.status,
          date: row.invoiceDate,
          dueDate: row.dueDate,
          total: row.total,
          amountDue: row.amountDue,
          amountPaid: row.amountPaid,
        })),
      };
      break;
  }

  if (input.entity === "contacts") {
    payload = { contacts: (await repo.listContacts(input.companyId)).slice(0, input.limit ?? 25) };
  }
  if (input.entity === "payments") {
    payload = { payments: (await repo.listPayments(input.companyId, { fromDate, toDate })).slice(0, input.limit ?? 25) };
  }

  const invoiced = invoices
    .filter((row) => row.type === "ACCREC" && row.isCurrent && row.status !== "VOIDED" && row.status !== "DELETED")
    .reduce((sum, row) => sum + (row.total ?? 0), 0);
  if (aggregation === "outstanding_total") {
    payload = {
      ...payload,
      invoicedValue: invoiced,
      outstandingProportion: invoiced > 0 ? outstandingMetrics.outstanding / invoiced : null,
    };
  }

  const recordCount = warehouseRecordCount(aggregation, payload);
  const warning = partialRange
    ? "Warehouse month(s) in this range are still backfilling. Totals are grounded but not complete. Do not treat them as authoritative period sales."
    : undefined;
  return {
    ok: true,
    customerChargeCents: warehouseChildDebitCents(),
    evidence: { ...evidence, completenessStatus: rangeStatus },
    result: normalizeWarehouseContract({
      ...payload,
      fromDate,
      toDate,
      source: "xero_warehouse",
      warehouseAsOf,
      warehouse_as_of: warehouseAsOf,
      health,
      completeness_status: rangeStatus,
      completenessStatus: rangeStatus,
      period_start: fromDate,
      period_end: toDate,
      record_count: recordCount,
      partial: partialRange,
      partial_reason: partialRange ? "month_range_incomplete" : undefined,
      warning,
    }),
  };
}

export function normalizeWarehouseContract(payload: Record<string, unknown>): Record<string, unknown> {
  const fromDate = asOptionalString(payload.fromDate ?? payload.period_start);
  const toDate = asOptionalString(payload.toDate ?? payload.period_end);
  const asOf = asOptionalString(payload.warehouse_as_of ?? payload.warehouseAsOf);
  const completeness = asOptionalString(payload.completeness_status ?? payload.completenessStatus);
  const partial =
    payload.partial === true ||
    completeness === "PARTIAL" ||
    completeness === "BACKFILLING" ||
    completeness === "NEVER_SYNCED";
  return {
    ...payload,
    source: "xero_warehouse",
    warehouseAsOf: asOf,
    warehouse_as_of: asOf,
    completenessStatus: completeness,
    completeness_status: completeness,
    fromDate,
    toDate,
    period_start: fromDate ?? payload.period_start ?? null,
    period_end: toDate ?? payload.period_end ?? null,
    record_count:
      typeof payload.record_count === "number"
        ? payload.record_count
        : warehouseRecordCount(undefined, payload),
    partial,
    partial_reason: partial
      ? asOptionalString(payload.partial_reason) ?? asOptionalString(payload.warning) ?? "month_range_incomplete"
      : payload.partial_reason ?? undefined,
  };
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function warehouseRecordCount(aggregation: WarehouseAggregation | undefined, payload: Record<string, unknown>): number | null {
  if (typeof payload.record_count === "number") return payload.record_count;
  if (typeof payload.invoiceCount === "number") return payload.invoiceCount;
  if (Array.isArray(payload.months)) {
    return payload.months.reduce((sum, row) => {
      const count = row && typeof row === "object" && "invoiceCount" in row ? Number((row as { invoiceCount?: unknown }).invoiceCount) : 0;
      return sum + (Number.isFinite(count) ? count : 0);
    }, 0);
  }
  if (Array.isArray(payload.invoices)) return payload.invoices.length;
  if (Array.isArray(payload.customers)) return payload.customers.length;
  if (Array.isArray(payload.contacts)) return payload.contacts.length;
  if (Array.isArray(payload.payments)) return payload.payments.length;
  if (aggregation === "sales_total" && typeof payload.sales === "number") return 1;
  return null;
}

function defaultAggregation(input: WarehouseQueryRequest): WarehouseAggregation {
  if (input.entity === "snapshots") return "snapshot_series";
  if (input.entity === "kpis") return "kpi_latest";
  if (input.entity === "invoices") return "invoice_list";
  return "sales_total";
}
