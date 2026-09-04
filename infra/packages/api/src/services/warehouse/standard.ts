/**
 * INFRA Business Data Warehouse Standard — shared contracts.
 * Tenant-aware. Connector-agnostic. EL Xero is the first adapter.
 */

export const WAREHOUSE_TIMEZONE = "Europe/London";
export const WAREHOUSE_EL_COMPANY_ID = "co_el";
export const WAREHOUSE_XERO_CONNECTOR = "xero";

export const WAREHOUSE_HEALTH = ["HEALTHY", "DEGRADED", "FAILED", "NEVER_SYNCED"] as const;
export type WarehouseHealth = (typeof WAREHOUSE_HEALTH)[number];

export const WAREHOUSE_SYNC_STATUSES = [
  "running",
  "success",
  "degraded",
  "failed",
  "skipped_locked",
] as const;
export type WarehouseSyncStatus = (typeof WAREHOUSE_SYNC_STATUSES)[number];

export const WAREHOUSE_TRIGGERS = ["scheduled", "backfill", "manual"] as const;
export type WarehouseTrigger = (typeof WAREHOUSE_TRIGGERS)[number];

export const WAREHOUSE_FRESHNESS_CLASSES = [
  "HISTORICAL_ANALYTICAL",
  "CURRENT_LIVE_STATE",
  "CURRENT_BUT_WAREHOUSE_FRESH_ENOUGH",
  "UNCERTAIN",
] as const;
export type WarehouseFreshnessClass = (typeof WAREHOUSE_FRESHNESS_CLASSES)[number];

export const WAREHOUSE_EVIDENCE_SOURCES = ["xero_live", "xero_warehouse"] as const;
export type WarehouseEvidenceSource = (typeof WAREHOUSE_EVIDENCE_SOURCES)[number];

export const WAREHOUSE_FAILURE_CODES = [
  "WAREHOUSE_SYNC_FAILED",
  "WAREHOUSE_STALE",
  "WAREHOUSE_RECONCILIATION_FAILED",
  "WAREHOUSE_QUERY_FAILED",
  "WAREHOUSE_SOURCE_DIVERGENCE",
  "WAREHOUSE_LOCKED",
  "WAREHOUSE_XERO_UNAVAILABLE",
] as const;
export type WarehouseFailureCode = (typeof WAREHOUSE_FAILURE_CODES)[number];

export const WAREHOUSE_TOOL_NAMES = [
  "warehouse_sales_analysis",
  "warehouse_invoice_analysis",
  "warehouse_receivables_analysis",
  "warehouse_customer_analysis",
  "warehouse_query",
] as const;
export type WarehouseToolName = (typeof WAREHOUSE_TOOL_NAMES)[number];

export const WAREHOUSE_STALE_AFTER_MS = 4 * 60 * 60 * 1000;
export const WAREHOUSE_FRESH_ENOUGH_MS = 2 * 60 * 60 * 1000;
export const WAREHOUSE_LOCK_TTL_MS = 12 * 60 * 1000;
export const WAREHOUSE_RECONCILE_ABS_TOLERANCE = 0.02;
export const WAREHOUSE_SNAPSHOT_RETENTION_DAYS = 365 * 3;
export const WAREHOUSE_MAX_PAGES = 50;
export const WAREHOUSE_PAGE_SIZE = 100;

export const WAREHOUSE_WEEKDAY_HOURS = [7, 9, 11, 13, 15, 17, 19] as const;
export const WAREHOUSE_WEEKEND_HOURS = [12] as const;
export const WAREHOUSE_SLOTS_PER_WEEK =
  WAREHOUSE_WEEKDAY_HOURS.length * 5 + WAREHOUSE_WEEKEND_HOURS.length * 2;

export type WarehouseCheckpoint = {
  mode: "backfill" | "incremental";
  invoicesUpdatedAfter?: string | null;
  contactsUpdatedAfter?: string | null;
  paymentsUpdatedAfter?: string | null;
  creditNotesUpdatedAfter?: string | null;
  historyFrom?: string | null;
  historyTo?: string | null;
  sourceTimestamp?: string | null;
};

export type WarehouseSource = {
  companyId: string;
  connector: string;
  status: WarehouseHealth;
  lastSuccessfulSync: string | null;
  lastAttemptedSync: string | null;
  warehouseLastUpdatedAt: string | null;
  sourceLastUpdatedAt: string | null;
  syncStatus: string | null;
  checkpoint: WarehouseCheckpoint | null;
  historicalFrom: string | null;
  historicalTo: string | null;
  lastReconciliation: WarehouseReconciliation | null;
  lastFailureCode: string | null;
  recordCounts: WarehouseRecordCounts;
  lockOwner: string | null;
  lockUntil: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WarehouseRecordCounts = {
  invoices: number;
  invoiceLines: number;
  contacts: number;
  payments: number;
  creditNotes: number;
  snapshots: number;
};

export type WarehouseReconciliation = {
  comparedAt: string;
  mtdSalesWarehouse: number | null;
  mtdSalesLive: number | null;
  invoiceCountWarehouse: number | null;
  invoiceCountLive: number | null;
  outstandingWarehouse: number | null;
  outstandingLive: number | null;
  overdueWarehouse: number | null;
  overdueLive: number | null;
  passed: boolean;
  divergence: string[];
  tolerance: number;
};

export type WarehouseSyncRun = {
  syncId: string;
  companyId: string;
  connector: string;
  trigger: WarehouseTrigger;
  scheduledFor: string | null;
  startedAt: string;
  completedAt: string | null;
  checkpointBefore: string | null;
  checkpointAfter: string | null;
  recordsRead: number;
  recordsInserted: number;
  recordsUpdated: number;
  snapshotsWritten: number;
  status: WarehouseSyncStatus;
  failureCode: string | null;
  latencyMs: number | null;
  reconciliation: WarehouseReconciliation | null;
};

export type WarehouseXeroInvoice = {
  companyId: string;
  invoiceId: string;
  invoiceNumber: string | null;
  type: string | null;
  contactId: string | null;
  contactName: string | null;
  status: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  reference: string | null;
  currency: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  amountDue: number | null;
  amountPaid: number | null;
  amountCredited: number | null;
  sourceUpdatedAt: string | null;
  warehouseUpdatedAt: string;
  isCurrent: boolean;
};

export type WarehouseXeroInvoiceLine = {
  companyId: string;
  invoiceId: string;
  lineId: string;
  description: string | null;
  quantity: number | null;
  unitAmount: number | null;
  tax: number | null;
  lineTotal: number | null;
  accountCode: string | null;
  warehouseUpdatedAt: string;
};

export type WarehouseXeroContact = {
  companyId: string;
  contactId: string;
  displayName: string | null;
  status: string | null;
  isCustomer: boolean | null;
  isSupplier: boolean | null;
  accountNumber: string | null;
  sourceUpdatedAt: string | null;
  warehouseUpdatedAt: string;
  isCurrent: boolean;
};

export type WarehouseXeroPayment = {
  companyId: string;
  paymentId: string;
  invoiceId: string | null;
  paymentDate: string | null;
  amount: number | null;
  status: string | null;
  paymentType: string | null;
  reference: string | null;
  sourceUpdatedAt: string | null;
  warehouseUpdatedAt: string;
  isCurrent: boolean;
};

export type WarehouseXeroCreditNote = {
  companyId: string;
  creditNoteId: string;
  creditNoteNumber: string | null;
  type: string | null;
  contactId: string | null;
  contactName: string | null;
  status: string | null;
  creditDate: string | null;
  reference: string | null;
  currency: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  remainingCredit: number | null;
  sourceUpdatedAt: string | null;
  warehouseUpdatedAt: string;
  isCurrent: boolean;
};

export type WarehouseKpiSnapshot = {
  companyId: string;
  connector: string;
  asOf: string;
  syncId: string | null;
  salesMtd: number;
  salesToday: number;
  invoiceCountMtd: number;
  outstandingReceivables: number;
  overdueReceivables: number;
  overdueInvoiceCount: number;
  paidAmountMtd: number;
  topCustomers: Array<{ contactId: string; name: string; total: number }>;
  currency: string | null;
  createdAt: string;
};

export type WarehouseEvidence = {
  source: WarehouseEvidenceSource;
  warehouseAsOf: string | null;
  freshnessClass: WarehouseFreshnessClass;
  health: WarehouseHealth;
  companyId: string;
  connector: string;
};

export const EMPTY_RECORD_COUNTS: WarehouseRecordCounts = {
  invoices: 0,
  invoiceLines: 0,
  contacts: 0,
  payments: 0,
  creditNotes: 0,
  snapshots: 0,
};

export function isWarehouseToolName(name: string): boolean {
  return (WAREHOUSE_TOOL_NAMES as readonly string[]).includes(name);
}

export function warehouseTrafficClass(): "AUTOMATION" {
  return "AUTOMATION";
}

export function warehouseChildDebitCents(): 0 {
  return 0;
}
