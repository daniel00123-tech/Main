/**
 * Connector adapter contract for the INFRA business data warehouse.
 * Future sources (Commusoft, BigChange, CRM, tickets) implement this.
 * Do not implement those adapters in V1.
 */

import type {
  WarehouseCheckpoint,
  WarehouseReconciliation,
  WarehouseXeroContact,
  WarehouseXeroCreditNote,
  WarehouseXeroInvoice,
  WarehouseXeroInvoiceLine,
  WarehouseXeroPayment,
} from "../standard";

export type WarehouseExtract = {
  invoices: WarehouseXeroInvoice[];
  invoiceLines: WarehouseXeroInvoiceLine[];
  contacts: WarehouseXeroContact[];
  payments: WarehouseXeroPayment[];
  creditNotes: WarehouseXeroCreditNote[];
  checkpoint: WarehouseCheckpoint;
  recordsRead: number;
  truncated: boolean;
  organisation?: {
    name?: string | null;
    currency?: string | null;
    financialYearStart?: string | null;
    historicalFrom?: string | null;
    historicalTo?: string | null;
  };
};

export type WarehouseLiveTotals = {
  mtdSales: number | null;
  invoiceCount: number | null;
  outstanding: number | null;
  overdue: number | null;
  unavailable?: boolean;
};

export type WarehouseConnectorAdapter = {
  connector: string;
  extract(input: {
    companyId: string;
    checkpoint: WarehouseCheckpoint | null;
    now: Date;
    trigger: "scheduled" | "backfill" | "manual";
    storedInvoices?: Array<{ invoiceDate: string | null }>;
  }): Promise<WarehouseExtract>;
  liveTotals?(input: { companyId: string; now: Date }): Promise<WarehouseLiveTotals>;
};

export type WarehouseReconcileInput = {
  warehouse: {
    mtdSales: number;
    invoiceCount: number;
    outstanding: number;
    overdue: number;
  };
  live: WarehouseLiveTotals;
  comparedAt: string;
  tolerance: number;
};

export function buildReconciliation(input: WarehouseReconcileInput): WarehouseReconciliation {
  const divergence: string[] = [];
  const compare = (label: string, warehouse: number | null, live: number | null) => {
    if (warehouse == null || live == null) return;
    if (Math.abs(warehouse - live) > input.tolerance) divergence.push(label);
  };
  compare("mtd_sales", input.warehouse.mtdSales, input.live.mtdSales);
  compare("invoice_count", input.warehouse.invoiceCount, input.live.invoiceCount);
  compare("outstanding", input.warehouse.outstanding, input.live.outstanding);
  compare("overdue", input.warehouse.overdue, input.live.overdue);
  return {
    comparedAt: input.comparedAt,
    mtdSalesWarehouse: input.warehouse.mtdSales,
    mtdSalesLive: input.live.mtdSales,
    invoiceCountWarehouse: input.warehouse.invoiceCount,
    invoiceCountLive: input.live.invoiceCount,
    outstandingWarehouse: input.warehouse.outstanding,
    outstandingLive: input.live.outstanding,
    overdueWarehouse: input.warehouse.overdue,
    overdueLive: input.live.overdue,
    passed: !input.live.unavailable && divergence.length === 0,
    divergence,
    tolerance: input.tolerance,
  };
}
