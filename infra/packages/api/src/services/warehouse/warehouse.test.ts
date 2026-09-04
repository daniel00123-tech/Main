import { describe, expect, it } from "vitest";
import {
  classifyQueryFreshness,
  preferredSource,
  warehouseIsFreshEnough,
  warehouseIsStale,
} from "./freshness";
import {
  computeNextWarehouseSlot,
  computeNextWarehouseSyncUtcIso,
  describeWarehouseSchedule,
  isWarehouseLocalSlot,
  listWarehouseSlotsForLocalWeek,
  warehouseSlotsPerWeek,
} from "./schedule";
import { getZonedParts } from "../automation-engine/schedule";
import { createMemoryWarehouseRepository, newWarehouseSource } from "./store";
import { continueWarehouseSync, runWarehouseSync } from "./sync";
import { executeWarehouseQuery, validateWarehouseQuery } from "./query";
import { executeWarehouseTool, isWarehouseToolName, withWarehouseTools } from "./tools";
import { buildReconciliation } from "./adapters/types";
import {
  computeWarehouseSalesMetrics,
  dateWindows,
  financialYearWindow,
  normaliseInvoice,
  parseXeroTimestamp,
  stableXeroEntityId,
} from "./adapters/xero";
import {
  applyWindowResult,
  inferMonthStatuses,
  planCatchupWindows,
  seedProgressiveCheckpoint,
  summariseCompleteness,
  windowHitsCap,
  windowIsComplete,
} from "./windows";
import { COMPANY_MCP_RESULT_CAP, deriveWarehouseHealth } from "./standard";
import { warehouseBackfillCompleteEmail } from "./email";
import {
  WAREHOUSE_EL_COMPANY_ID,
  WAREHOUSE_RECONCILE_ABS_TOLERANCE,
  WAREHOUSE_TIMEZONE,
  WAREHOUSE_XERO_CONNECTOR,
  warehouseChildDebitCents,
  warehouseTrafficClass,
  type WarehouseXeroInvoice,
} from "./standard";
import { elChildUsageShouldDebit, shouldChargeElCustomerRequest } from "../el-customer-billing";
import { withXeroReadTools } from "../xero-read-tools";
import { buildAllowedToolCatalogue } from "../intelligence/tool-auth";
import { PRODUCTION_SUPERSTACK_CAPABILITIES } from "../production-lineage";
import type { WarehouseConnectorAdapter, WarehouseExtract } from "./adapters/types";

function invoice(partial: Partial<WarehouseXeroInvoice> & { invoiceId: string; companyId?: string }): WarehouseXeroInvoice {
  return {
    companyId: partial.companyId ?? WAREHOUSE_EL_COMPANY_ID,
    invoiceNumber: partial.invoiceNumber ?? `INV-${partial.invoiceId}`,
    type: partial.type ?? "ACCREC",
    contactId: partial.contactId ?? "ct_1",
    contactName: partial.contactName ?? "Acme",
    status: partial.status ?? "AUTHORISED",
    invoiceDate: partial.invoiceDate ?? "2026-09-02",
    dueDate: partial.dueDate ?? "2026-09-30",
    reference: partial.reference ?? null,
    currency: "GBP",
    subtotal: partial.subtotal ?? 100,
    tax: partial.tax ?? 20,
    total: partial.total ?? 120,
    amountDue: partial.amountDue ?? 120,
    amountPaid: partial.amountPaid ?? 0,
    amountCredited: partial.amountCredited ?? 0,
    sourceUpdatedAt: partial.sourceUpdatedAt ?? "2026-09-02T10:00:00.000Z",
    warehouseUpdatedAt: "2026-09-04T10:00:00.000Z",
    isCurrent: partial.isCurrent ?? true,
    invoiceId: partial.invoiceId,
  };
}

function extractFrom(invoices: WarehouseXeroInvoice[], extras?: Partial<WarehouseExtract>): WarehouseExtract {
  return {
    invoices,
    invoiceLines: extras?.invoiceLines ?? [],
    contacts: extras?.contacts ?? [],
    payments: extras?.payments ?? [],
    creditNotes: extras?.creditNotes ?? [],
    recordsRead: invoices.length + (extras?.invoiceLines?.length ?? 0),
    truncated: extras?.truncated ?? false,
    organisation: extras?.organisation ?? {
      currency: "GBP",
      historicalFrom: "2025-04-01",
      historicalTo: "2026-09-04",
    },
    checkpoint: extras?.checkpoint ?? {
      mode: "backfill",
      sourceTimestamp: "2026-09-04T10:00:00.000Z",
      historyFrom: "2025-04-01",
      historyTo: "2026-09-04",
      completeness: "COMPLETE",
    },
  };
}

function adapter(extracts: WarehouseExtract[], live?: { mtdSales: number; invoiceCount: number; outstanding: number; overdue: number }): WarehouseConnectorAdapter {
  let i = 0;
  return {
    connector: WAREHOUSE_XERO_CONNECTOR,
    async extract() {
      return extracts[Math.min(i++, extracts.length - 1)]!;
    },
    async liveTotals() {
      return live ?? {
        mtdSales: extracts[0]?.invoices.reduce((s, row) => s + (row.total ?? 0), 0) ?? 0,
        invoiceCount: extracts[0]?.invoices.length ?? 0,
        outstanding: extracts[0]?.invoices.reduce((s, row) => s + (row.amountDue ?? 0), 0) ?? 0,
        overdue: 0,
      };
    },
  };
}

describe("warehouse schedule DST", () => {
  it("has exactly 37 London slots and no overnight/hourly/extra weekend", () => {
    const schedule = describeWarehouseSchedule();
    expect(warehouseSlotsPerWeek()).toBe(37);
    expect(schedule.timezone).toBe("Europe/London");
    expect(schedule.overnight).toBe(false);
    expect(schedule.hourly).toBe(false);
    expect(schedule.extraWeekend).toBe(false);
    const week = listWarehouseSlotsForLocalWeek(new Date("2026-09-07T12:00:00.000Z"));
    expect(week).toHaveLength(37);
    expect(week.filter((slot) => slot.weekday === 6).map((slot) => slot.hour)).toEqual([12]);
    expect(week.filter((slot) => slot.weekday === 0).map((slot) => slot.hour)).toEqual([12]);
    expect(week.some((slot) => slot.hour < 7 || slot.hour > 19)).toBe(false);
    expect(week.some((slot) => slot.weekday >= 1 && slot.weekday <= 5 && slot.hour === 12 && ![7, 9, 11, 13, 15, 17, 19].includes(slot.hour))).toBe(false);
  });

  it("keeps weekday 07:00 local across GMT, BST, and both 2026 transitions", () => {
    const gmt = computeNextWarehouseSlot(new Date("2026-01-06T06:59:00.000Z"));
    expect(gmt.hour).toBe(7);
    expect(getZonedParts(new Date(gmt.utcIso), WAREHOUSE_TIMEZONE).hour).toBe(7);

    const bst = computeNextWarehouseSlot(new Date("2026-07-07T05:59:00.000Z"));
    expect(bst.hour).toBe(7);
    expect(getZonedParts(new Date(bst.utcIso), WAREHOUSE_TIMEZONE).hour).toBe(7);
    expect(bst.utcIso).toBe("2026-07-07T06:00:00.000Z");

    const springMonday = computeNextWarehouseSlot(new Date("2026-03-30T05:30:00.000Z"));
    expect(getZonedParts(new Date(springMonday.utcIso), WAREHOUSE_TIMEZONE)).toMatchObject({
      hour: 7,
      minute: 0,
      weekday: 1,
    });

    const autumnMonday = computeNextWarehouseSlot(new Date("2026-10-26T06:30:00.000Z"));
    expect(getZonedParts(new Date(autumnMonday.utcIso), WAREHOUSE_TIMEZONE)).toMatchObject({
      hour: 7,
      minute: 0,
      weekday: 1,
    });
  });

  it("moves Friday 19:00 to Saturday 12:00 then Sunday 12:00 then Monday 07:00", () => {
    const fridayEvening = computeNextWarehouseSlot(new Date("2026-09-04T18:05:00.000Z"));
    expect(fridayEvening.weekday).toBe(6);
    expect(fridayEvening.hour).toBe(12);
    const sunday = computeNextWarehouseSlot(new Date(fridayEvening.utcIso));
    expect(sunday.weekday).toBe(0);
    expect(sunday.hour).toBe(12);
    const monday = computeNextWarehouseSlot(new Date(sunday.utcIso));
    expect(monday.weekday).toBe(1);
    expect(monday.hour).toBe(7);
  });

  it("does not treat 03:00 or Saturday 07:00 as slots", () => {
    expect(isWarehouseLocalSlot({ weekday: 2, hour: 3, minute: 0 })).toBe(false);
    expect(isWarehouseLocalSlot({ weekday: 6, hour: 7, minute: 0 })).toBe(false);
    expect(isWarehouseLocalSlot({ weekday: 3, hour: 19, minute: 0 })).toBe(true);
  });
});

describe("warehouse freshness policy", () => {
  it("classifies historical vs current vs uncertain without phrase patches as the API", () => {
    expect(classifyQueryFreshness("What were our sales each month for the last six months?")).toBe(
      "HISTORICAL_ANALYTICAL",
    );
    expect(classifyQueryFreshness("How has overdue debt moved over time?")).toBe("HISTORICAL_ANALYTICAL");
    expect(classifyQueryFreshness("What are sales right now?")).toBe("CURRENT_LIVE_STATE");
    expect(classifyQueryFreshness("Has invoice INV-123 been paid yet?")).toBe("CURRENT_LIVE_STATE");
    expect(classifyQueryFreshness("What is the newest invoice?")).toBe("CURRENT_LIVE_STATE");
    expect(classifyQueryFreshness("Tell me about the weather")).toBe("UNCERTAIN");
  });

  it("prefers live when stale/degraded and warehouse when historical healthy", () => {
    expect(preferredSource({ freshnessClass: "HISTORICAL_ANALYTICAL", health: "HEALTHY" })).toBe("warehouse");
    expect(preferredSource({ freshnessClass: "CURRENT_LIVE_STATE", health: "HEALTHY" })).toBe("live");
    expect(preferredSource({ freshnessClass: "HISTORICAL_ANALYTICAL", health: "DEGRADED" })).toBe("explain");
    expect(preferredSource({ freshnessClass: "CURRENT_LIVE_STATE", health: "FAILED" })).toBe("live");
    expect(warehouseIsStale(new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString())).toBe(true);
    expect(warehouseIsFreshEnough(new Date(Date.now() - 30 * 60 * 1000).toISOString())).toBe(true);
  });
});

describe("warehouse sync + isolation", () => {
  it("backfills, stays idempotent, updates paid/void, and never leaks tenants", async () => {
    const repo = createMemoryWarehouseRepository();
    await repo.upsertSource(newWarehouseSource({ companyId: WAREHOUSE_EL_COMPANY_ID, connector: WAREHOUSE_XERO_CONNECTOR }));
    await repo.upsertSource(newWarehouseSource({ companyId: "co_ht", connector: WAREHOUSE_XERO_CONNECTOR }));

    const first = extractFrom([invoice({ invoiceId: "inv_1", total: 120, amountDue: 120 })]);
    const result = await runWarehouseSync({
      repo,
      adapter: adapter([first]),
      companyId: WAREHOUSE_EL_COMPANY_ID,
      trigger: "backfill",
      now: new Date("2026-09-04T10:00:00.000Z"),
    });
    expect(result.ran).toBe(true);
    expect(result.run?.status).toBe("success");
    expect((await repo.listInvoices(WAREHOUSE_EL_COMPANY_ID)).length).toBe(1);
    expect((await repo.listInvoices("co_ht")).length).toBe(0);
    expect(await repo.getInvoice("co_ht", "inv_1")).toBeNull();

    const paid = extractFrom([
      invoice({ invoiceId: "inv_1", status: "PAID", amountDue: 0, amountPaid: 120, total: 120 }),
    ]);
    const second = await runWarehouseSync({
      repo,
      adapter: adapter([paid], { mtdSales: 120, invoiceCount: 1, outstanding: 0, overdue: 0 }),
      companyId: WAREHOUSE_EL_COMPANY_ID,
      trigger: "scheduled",
      now: new Date("2026-09-04T12:00:00.000Z"),
    });
    expect(second.run?.recordsInserted).toBe(0);
    expect(second.run?.recordsUpdated).toBeGreaterThan(0);
    expect((await repo.getInvoice(WAREHOUSE_EL_COMPANY_ID, "inv_1"))?.status).toBe("PAID");

    const voided = extractFrom([
      invoice({ invoiceId: "inv_1", status: "VOIDED", isCurrent: false, total: 120, amountDue: 0 }),
    ]);
    await runWarehouseSync({
      repo,
      adapter: adapter([voided], { mtdSales: 0, invoiceCount: 0, outstanding: 0, overdue: 0 }),
      companyId: WAREHOUSE_EL_COMPANY_ID,
      trigger: "scheduled",
      now: new Date("2026-09-04T14:00:00.000Z"),
    });
    expect((await repo.getInvoice(WAREHOUSE_EL_COMPANY_ID, "inv_1"))?.isCurrent).toBe(false);
    expect((await repo.listInvoices(WAREHOUSE_EL_COMPANY_ID, { currentOnly: true })).length).toBe(0);
  });

  it("keeps the lock after a status upsert so a second sync cannot start", async () => {
    const repo = createMemoryWarehouseRepository();
    const source = newWarehouseSource({ companyId: WAREHOUSE_EL_COMPANY_ID, connector: WAREHOUSE_XERO_CONNECTOR });
    await repo.upsertSource(source);
    const nowIso = new Date().toISOString();
    const acquired = await repo.tryAcquireLock({
      companyId: WAREHOUSE_EL_COMPANY_ID,
      connector: WAREHOUSE_XERO_CONNECTOR,
      owner: "owner-a",
      untilIso: new Date(Date.now() + 60_000).toISOString(),
      nowIso,
    });
    expect(acquired).toBe(true);
    const running = await repo.getSource(WAREHOUSE_EL_COMPANY_ID, WAREHOUSE_XERO_CONNECTOR);
    expect(running?.lockOwner).toBe("owner-a");
    running!.syncStatus = "running";
    running!.lockOwner = null;
    running!.lockUntil = null;
    await repo.upsertSource(running!);
    const stillLocked = await repo.getSource(WAREHOUSE_EL_COMPANY_ID, WAREHOUSE_XERO_CONNECTOR);
    expect(stillLocked?.lockOwner).toBe("owner-a");
    const result = await runWarehouseSync({
      repo,
      adapter: adapter([extractFrom([])]),
      companyId: WAREHOUSE_EL_COMPANY_ID,
      trigger: "scheduled",
    });
    expect(result.skipped).toBe("locked");
  });

  it("continues a chunked backfill without resetting the checkpoint", async () => {
    const repo = createMemoryWarehouseRepository();
    const source = newWarehouseSource({ companyId: WAREHOUSE_EL_COMPANY_ID, connector: WAREHOUSE_XERO_CONNECTOR });
    source.checkpoint = {
      mode: "backfill",
      historyFrom: "2025-01-01",
      historyTo: "2026-09-04",
      backfillCursor: "2025-05-01",
      sourceTimestamp: "2026-09-04T20:43:04.012Z",
    };
    await repo.upsertSource(source);
    const result = await continueWarehouseSync({
      env: undefined as never,
      repo,
      adapter: adapter(
        [
          extractFrom([invoice({ invoiceId: "INV-MAY", invoiceDate: "2026-09-02", total: 80, amountDue: 80 })], {
            checkpoint: {
              mode: "incremental",
              historyFrom: "2025-01-01",
              historyTo: "2026-09-04",
              sourceTimestamp: "2026-09-04T20:50:00.000Z",
            },
          }),
        ],
        { mtdSales: 80, invoiceCount: 1, outstanding: 80, overdue: 0 },
      ),
      now: new Date("2026-09-04T20:50:00.000Z"),
    });
    expect(result.ran).toBe(true);
    expect(result.source?.checkpoint?.historyFrom).toBe("2025-01-01");
    expect(result.source?.checkpoint?.mode).toBe("incremental");
    expect((await repo.getInvoice(WAREHOUSE_EL_COMPANY_ID, "INV-MAY"))?.total).toBe(80);
  });

  it("records skipped_locked when a sync is already running", async () => {
    const repo = createMemoryWarehouseRepository();
    const source = newWarehouseSource({ companyId: WAREHOUSE_EL_COMPANY_ID, connector: WAREHOUSE_XERO_CONNECTOR });
    source.lockOwner = "other";
    source.lockUntil = new Date(Date.now() + 60_000).toISOString();
    await repo.upsertSource(source);
    const result = await runWarehouseSync({
      repo,
      adapter: adapter([extractFrom([])]),
      companyId: WAREHOUSE_EL_COMPANY_ID,
      trigger: "scheduled",
    });
    expect(result.skipped).toBe("locked");
    expect(result.run?.status).toBe("skipped_locked");
  });

  it("marks DEGRADED when live totals diverge and does not rewrite warehouse numbers", async () => {
    const repo = createMemoryWarehouseRepository();
    await repo.upsertSource(newWarehouseSource({ companyId: WAREHOUSE_EL_COMPANY_ID, connector: WAREHOUSE_XERO_CONNECTOR }));
    const result = await runWarehouseSync({
      repo,
      adapter: adapter([extractFrom([invoice({ invoiceId: "inv_2", total: 500 })]),], {
        mtdSales: 10,
        invoiceCount: 99,
        outstanding: 1,
        overdue: 1,
      }),
      companyId: WAREHOUSE_EL_COMPANY_ID,
      trigger: "backfill",
    });
    expect(result.source?.status).toBe("DEGRADED");
    expect(result.run?.reconciliation?.passed).toBe(false);
    expect((await repo.getInvoice(WAREHOUSE_EL_COMPANY_ID, "inv_2"))?.total).toBe(500);
  });

  it("persists checkpoint and uses incremental extract on the next run", async () => {
    const repo = createMemoryWarehouseRepository();
    await repo.upsertSource(newWarehouseSource({ companyId: WAREHOUSE_EL_COMPANY_ID, connector: WAREHOUSE_XERO_CONNECTOR }));
    const seen: Array<string | undefined> = [];
    const incremental: WarehouseConnectorAdapter = {
      connector: WAREHOUSE_XERO_CONNECTOR,
      async extract(input) {
        seen.push(input.checkpoint?.sourceTimestamp ?? undefined);
        return extractFrom([invoice({ invoiceId: "inv_3" })], {
          checkpoint: {
            mode: input.checkpoint ? "incremental" : "backfill",
            sourceTimestamp: "2026-09-04T11:00:00.000Z",
            historyFrom: "2025-04-01",
            historyTo: "2026-09-04",
          },
        });
      },
      async liveTotals() {
        return { mtdSales: 120, invoiceCount: 1, outstanding: 120, overdue: 0 };
      },
    };
    await runWarehouseSync({
      repo,
      adapter: incremental,
      companyId: WAREHOUSE_EL_COMPANY_ID,
      trigger: "backfill",
    });
    await runWarehouseSync({
      repo,
      adapter: incremental,
      companyId: WAREHOUSE_EL_COMPANY_ID,
      trigger: "scheduled",
    });
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toBe("2026-09-04T11:00:00.000Z");
  });

  it("records failure and retries without inventing success", async () => {
    const repo = createMemoryWarehouseRepository();
    await repo.upsertSource(newWarehouseSource({ companyId: WAREHOUSE_EL_COMPANY_ID, connector: WAREHOUSE_XERO_CONNECTOR }));
    let fail = true;
    const flaky: WarehouseConnectorAdapter = {
      connector: WAREHOUSE_XERO_CONNECTOR,
      async extract() {
        if (fail) {
          fail = false;
          throw Object.assign(new Error("xero 429"), { code: "WAREHOUSE_SYNC_FAILED" });
        }
        return extractFrom([invoice({ invoiceId: "inv_4" })]);
      },
      async liveTotals() {
        return { mtdSales: 120, invoiceCount: 1, outstanding: 120, overdue: 0 };
      },
    };
    const failed = await runWarehouseSync({
      repo,
      adapter: flaky,
      companyId: WAREHOUSE_EL_COMPANY_ID,
      trigger: "scheduled",
    });
    expect(failed.run?.status).toBe("failed");
    const retried = await runWarehouseSync({
      repo,
      adapter: flaky,
      companyId: WAREHOUSE_EL_COMPANY_ID,
      trigger: "scheduled",
    });
    expect(retried.run?.status).toBe("success");
  });
});

describe("warehouse query + live fallback", () => {
  it("serves historical analytics and refuses stale/degraded current data", async () => {
    const repo = createMemoryWarehouseRepository();
    const source = newWarehouseSource({ companyId: WAREHOUSE_EL_COMPANY_ID, connector: WAREHOUSE_XERO_CONNECTOR });
    source.status = "HEALTHY";
    source.lastSuccessfulSync = "2026-09-04T10:00:00.000Z";
    source.warehouseLastUpdatedAt = "2026-09-04T10:00:00.000Z";
    source.historicalFrom = "2025-04-01";
    source.historicalTo = "2026-09-04";
    await repo.upsertSource(source);
    await repo.upsertInvoice(invoice({ invoiceId: "inv_a", invoiceDate: "2026-08-15", total: 200, amountDue: 0, amountPaid: 200, status: "PAID" }));
    await repo.upsertInvoice(invoice({ invoiceId: "inv_b", invoiceDate: "2026-09-02", total: 300, amountDue: 300 }));

    const historical = await executeWarehouseQuery(repo, {
      companyId: WAREHOUSE_EL_COMPANY_ID,
      aggregation: "sales_by_month",
      fromDate: "2026-04-01",
      toDate: "2026-09-04",
      freshnessClass: "HISTORICAL_ANALYTICAL",
    });
    expect(historical.ok).toBe(true);
    expect(historical.evidence.source).toBe("xero_warehouse");
    expect(historical.customerChargeCents).toBe(0);

    source.status = "DEGRADED";
    await repo.upsertSource(source);
    const degraded = await executeWarehouseQuery(repo, {
      companyId: WAREHOUSE_EL_COMPANY_ID,
      aggregation: "sales_total",
      freshnessClass: "CURRENT_LIVE_STATE",
    });
    expect(degraded.ok).toBe(false);
    expect(degraded.fallback).toBe("xero_live");
    expect(degraded.reason).toBe("WAREHOUSE_RECONCILIATION_FAILED");
  });

  it("rejects SQL injection / cross-tenant query shapes", () => {
    expect(validateWarehouseQuery({ companyId: "", aggregation: "sales_total" }).ok).toBe(false);
    expect(
      validateWarehouseQuery({
        companyId: WAREHOUSE_EL_COMPANY_ID,
        aggregation: "drop table warehouse_xero_invoices" as never,
      }).ok,
    ).toBe(false);
    expect(validateWarehouseQuery({ companyId: WAREHOUSE_EL_COMPANY_ID, fromDate: "1; DROP TABLE x" }).ok).toBe(false);
  });

  it("exposes ChatGPT MCP warehouse tools and OpenAI evidence labels", async () => {
    expect(isWarehouseToolName("warehouse_sales_analysis")).toBe(true);
    const advertised = withWarehouseTools(withXeroReadTools([]));
    expect(advertised.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "warehouse_sales_analysis",
        "warehouse_invoice_analysis",
        "warehouse_receivables_analysis",
        "warehouse_customer_analysis",
        "warehouse_query",
        "xero_sales_summary",
      ]),
    );
    const repo = createMemoryWarehouseRepository();
    const source = newWarehouseSource({ companyId: WAREHOUSE_EL_COMPANY_ID, connector: WAREHOUSE_XERO_CONNECTOR });
    source.status = "HEALTHY";
    source.lastSuccessfulSync = new Date().toISOString();
    source.warehouseLastUpdatedAt = source.lastSuccessfulSync;
    await repo.upsertSource(source);
    await repo.upsertInvoice(invoice({ invoiceId: "inv_tool" }));
    const tool = await executeWarehouseTool({
      repo,
      companyId: WAREHOUSE_EL_COMPANY_ID,
      toolName: "warehouse_sales_analysis",
      arguments: { fromDate: "2026-09-01", toDate: "2026-09-04" },
      intentText: "What were our sales each month for the last six months?",
    });
    expect(tool.ok).toBe(true);
    if (tool.ok) {
      expect(tool.result.evidence).toMatchObject({ source: "xero_warehouse" });
      expect(tool.result.customerChargeCents).toBe(0);
    }
  });
});

describe("warehouse billing + deploy guard", () => {
  it("does not charge EL 3p for automation sync or child warehouse queries", () => {
    expect(warehouseTrafficClass()).toBe("AUTOMATION");
    expect(warehouseChildDebitCents()).toBe(0);
    expect(shouldChargeElCustomerRequest("co_el", "AUTOMATION")).toBe(false);
    expect(shouldChargeElCustomerRequest("co_el", "CUSTOMER_REQUEST")).toBe(true);
    expect(elChildUsageShouldDebit()).toBe(false);
  });

  it("keeps office_staff off warehouse tools and records the superstack capability", () => {
    const office = buildAllowedToolCatalogue({
      role: "office_staff",
      companyId: "co_el",
      connectors: ["conn_xero"],
    });
    expect(office.some((name) => name.startsWith("warehouse_"))).toBe(false);
    expect(PRODUCTION_SUPERSTACK_CAPABILITIES).toContain("business_data_warehouse");
    expect(computeNextWarehouseSyncUtcIso(new Date("2026-09-04T18:00:00.000Z"))).toBeTruthy();
  });
});

describe("xero normalisers", () => {
  it("maps Xero invoice/contact fields without inventing extras", () => {
    const mapped = normaliseInvoice(
      "co_el",
      {
        InvoiceID: "abc",
        InvoiceNumber: "INV-1",
        Type: "ACCREC",
        Status: "AUTHORISED",
        Date: "2026-09-02",
        DueDate: "2026-09-30",
        Reference: "PO-1",
        CurrencyCode: "GBP",
        SubTotal: 100,
        TotalTax: 20,
        Total: 120,
        AmountDue: 120,
        AmountPaid: 0,
        UpdatedDateUTC: "/Date(1756771200000)/",
        Contact: { ContactID: "c1", Name: "Acme" },
        LineItems: [{ LineItemID: "l1", Description: "Work", Quantity: 1, UnitAmount: 100, TaxAmount: 20, LineAmount: 120, AccountCode: "200" }],
      },
      "2026-09-04T10:00:00.000Z",
    );
    expect(mapped.invoice.invoiceId).toBe("abc");
    const numbered = normaliseInvoice(
      "co_el",
      { InvoiceNumber: "INV-88", Type: "ACCREC", Status: "AUTHORISED", Date: "2026-09-02", Total: 50 },
      "2026-09-04T10:00:00.000Z",
    );
    expect(numbered.invoice.invoiceId).toBe("INV-88");
    expect(stableXeroEntityId(null, "", "INV-88")).toBe("INV-88");
    expect(mapped.lines[0]?.accountCode).toBe("200");
    expect(parseXeroTimestamp("/Date(1756771200000)/")).toMatch(/T/);
    expect(mapped.invoice.invoiceDate).toBe("2026-09-02");
    const fy = financialYearWindow({ FinancialYearEndDay: 31, FinancialYearEndMonth: 3 }, new Date("2026-09-04T12:00:00.000Z"));
    expect(fy.historicalFrom).toBe("2025-04-01");
    expect(dateWindows("2026-08-01", "2026-09-04")).toEqual([
      { from: "2026-08-01", to: "2026-08-31" },
      { from: "2026-09-01", to: "2026-09-04" },
    ]);
    const metrics = computeWarehouseSalesMetrics([mapped.invoice], [], { today: "2026-09-04", monthStart: "2026-09-01" });
    expect(metrics.salesMtd).toBeGreaterThan(0);
    const rec = buildReconciliation({
      warehouse: { mtdSales: 10, invoiceCount: 1, outstanding: 10, overdue: 20 },
      live: { mtdSales: 10, invoiceCount: 1, outstanding: null, overdue: null },
      comparedAt: "x",
      tolerance: WAREHOUSE_RECONCILE_ABS_TOLERANCE,
    });
    expect(rec.passed).toBe(true);
  });
});

describe("progressive backfill windows", () => {
  it("treats 49 as complete and 50 as a cap hit", () => {
    expect(windowIsComplete(49)).toBe(true);
    expect(windowHitsCap(50)).toBe(true);
    expect(windowHitsCap(51)).toBe(true);
    expect(COMPANY_MCP_RESULT_CAP).toBe(50);
  });

  it("subdivides a 50-result month and completes after finer windows", () => {
    let months = inferMonthStatuses(
      Array.from({ length: 50 }, (_, i) => ({ invoiceDate: `2026-03-${String((i % 28) + 1).padStart(2, "0")}` })),
      "2026-03-01",
      "2026-03-31",
    );
    expect(months[0]?.status).toBe("PARTIAL");
    const capped = applyWindowResult(months, { from: "2026-03-01", to: "2026-03-31" }, 50, "month");
    expect(capped.nextGrain).toBe("week");
    expect(capped.nextCursor).toBe("2026-03-01");
    months = capped.months;
    const week = applyWindowResult(months, { from: "2026-03-01", to: "2026-03-07" }, 20, "week");
    expect(week.possiblyTruncated).toBe(false);
    expect(week.nextCursor).toBe("2026-03-08");
  });

  it("covers 51, 100 and 250 records across multi-window catch-up without treating a cap page as complete", () => {
    const dates = Array.from({ length: 250 }, (_, i) => {
      const day = (i % 28) + 1;
      const month = i < 51 ? "03" : i < 100 ? "04" : "05";
      return `2026-${month}-${String(day).padStart(2, "0")}`;
    });
    const records = dates.map((invoiceDate, i) => ({ id: `INV-${i}`, invoiceDate }));
    const fetchWindow = (from: string, to: string) =>
      records.filter((row) => row.invoiceDate >= from && row.invoiceDate <= to).slice(0, 50);
    let cursor: string | null = "2026-03-01";
    let grain: "month" | "week" | "day" = "month";
    let months = inferMonthStatuses(
      records.slice(0, 50).map((row) => ({ invoiceDate: row.invoiceDate })),
      "2026-03-01",
      "2026-05-31",
    );
    expect(summariseCompleteness(months)).toBe("PARTIAL");
    let seen = 0;
    const ids = new Set<string>();
    for (let step = 0; step < 40 && cursor && cursor <= "2026-05-31"; step += 1) {
      const rows = fetchWindow(cursor, cursor <= "2026-03-31" ? "2026-03-31" : cursor);
      seen += rows.length;
      for (const row of rows) ids.add(row.id);
      const applied = applyWindowResult(months, { from: cursor, to: rows.length ? rows[rows.length - 1]!.invoiceDate : cursor }, rows.length, grain);
      months = applied.months;
      cursor = applied.nextCursor;
      grain = applied.nextGrain;
      if (!cursor) break;
    }
    expect(ids.size).toBeGreaterThan(50);
    expect(windowHitsCap(50)).toBe(true);
    expect(seen).toBeGreaterThanOrEqual(51);
  });

  it("resumes from checkpoint and does not restart the historical range", () => {
    const seeded = seedProgressiveCheckpoint(
      {
        mode: "backfill",
        historyFrom: "2025-04-01",
        historyTo: "2026-09-04",
        backfillCursor: "2026-03-01",
        sourceTimestamp: "2026-09-04T10:00:00.000Z",
        months: [
          { month: "2026-03", status: "PARTIAL", recordsRetrieved: 50, nextWindowFrom: "2026-03-01" },
          { month: "2026-09", status: "COMPLETE", recordsRetrieved: 32, nextWindowFrom: null },
        ],
        completeness: "PARTIAL",
      },
      [{ invoiceDate: "2026-03-20" }, { invoiceDate: "2026-09-02" }],
      "2025-04-01",
      "2026-09-04",
    );
    expect(seeded.backfillCursor).toBe("2026-03-01");
    expect(seeded.historyFrom).toBe("2025-04-01");
    const plan = planCatchupWindows({
      cursor: seeded.backfillCursor ?? null,
      grain: "week",
      historyTo: "2026-09-04",
      currentMonthStart: "2026-09-01",
      budget: 3,
    });
    expect(plan[0]?.from).toBe("2026-03-01");
    expect(plan.every((win) => win.from < "2026-09-01")).toBe(true);
  });

  it("plans current month separately from historical catch-up", () => {
    const historical = planCatchupWindows({
      cursor: "2026-03-01",
      grain: "week",
      historyTo: "2026-09-04",
      currentMonthStart: "2026-09-01",
      budget: 2,
    });
    expect(historical[0]?.from).toBe("2026-03-01");
    expect(historical.some((win) => win.from >= "2026-09-01")).toBe(false);
  });

  it("does not mark incomplete history as DEGRADED", () => {
    expect(deriveWarehouseHealth({ completeness: "BACKFILLING", reconcilePassed: true })).toBe("BACKFILLING");
    expect(deriveWarehouseHealth({ completeness: "PARTIAL", reconcilePassed: true })).toBe("PARTIAL");
    expect(deriveWarehouseHealth({ completeness: "COMPLETE", reconcilePassed: true })).toBe("HEALTHY");
    expect(deriveWarehouseHealth({ completeness: "COMPLETE", reconcilePassed: false })).toBe("DEGRADED");
  });
});

describe("partial month query safety + resume sync", () => {
  it("flags a PARTIAL month and does not present it as complete", async () => {
    const repo = createMemoryWarehouseRepository();
    const source = newWarehouseSource({ companyId: WAREHOUSE_EL_COMPANY_ID, connector: WAREHOUSE_XERO_CONNECTOR });
    source.status = "PARTIAL";
    source.lastSuccessfulSync = "2026-09-04T10:00:00.000Z";
    source.warehouseLastUpdatedAt = source.lastSuccessfulSync;
    source.checkpoint = {
      mode: "backfill",
      completeness: "PARTIAL",
      historyFrom: "2025-04-01",
      historyTo: "2026-09-04",
      backfillCursor: "2026-03-08",
      months: [
        { month: "2026-03", status: "PARTIAL", recordsRetrieved: 50, nextWindowFrom: "2026-03-08" },
        { month: "2026-09", status: "COMPLETE", recordsRetrieved: 32, nextWindowFrom: null },
      ],
    };
    await repo.upsertSource(source);
    for (let i = 0; i < 50; i += 1) {
      await repo.upsertInvoice(
        invoice({
          invoiceId: `MAR-${i}`,
          invoiceDate: "2026-03-20",
          total: 10,
          amountDue: 0,
          amountPaid: 10,
          status: "PAID",
        }),
      );
    }
    const march = await executeWarehouseQuery(repo, {
      companyId: WAREHOUSE_EL_COMPANY_ID,
      aggregation: "sales_total",
      fromDate: "2026-03-01",
      toDate: "2026-03-31",
      freshnessClass: "HISTORICAL_ANALYTICAL",
    });
    expect(march.ok).toBe(true);
    expect(march.evidence.completenessStatus).toBe("PARTIAL");
    expect(march.result?.completeness_status).toBe("PARTIAL");
    expect(march.result?.partial).toBe(true);
    expect(String(march.result?.warning ?? "")).toMatch(/backfilling/i);
    expect(march.result?.sales).toBe(500);
    expect(march.customerChargeCents).toBe(0);

    const september = await executeWarehouseQuery(repo, {
      companyId: WAREHOUSE_EL_COMPANY_ID,
      aggregation: "sales_total",
      fromDate: "2026-09-01",
      toDate: "2026-09-04",
      freshnessClass: "HISTORICAL_ANALYTICAL",
    });
    expect(september.result?.completeness_status).toBe("COMPLETE");
    expect(september.result?.partial).toBe(false);
  });

  it("continues historical catch-up from the checkpoint and upserts the same id", async () => {
    const repo = createMemoryWarehouseRepository();
    const source = newWarehouseSource({ companyId: WAREHOUSE_EL_COMPANY_ID, connector: WAREHOUSE_XERO_CONNECTOR });
    source.checkpoint = {
      mode: "backfill",
      historyFrom: "2025-04-01",
      historyTo: "2026-09-04",
      backfillCursor: "2026-03-08",
      completeness: "PARTIAL",
      months: [{ month: "2026-03", status: "PARTIAL", recordsRetrieved: 50, nextWindowFrom: "2026-03-08" }],
    };
    await repo.upsertSource(source);
    await repo.upsertInvoice(invoice({ invoiceId: "INV-DUP", invoiceDate: "2026-03-20", total: 10 }));
    const result = await continueWarehouseSync({
      env: undefined as never,
      repo,
      adapter: adapter(
        [
          extractFrom([invoice({ invoiceId: "INV-DUP", invoiceDate: "2026-03-20", total: 15, amountDue: 15 })], {
            checkpoint: {
              mode: "backfill",
              historyFrom: "2025-04-01",
              historyTo: "2026-09-04",
              backfillCursor: "2026-03-15",
              completeness: "PARTIAL",
              sourceTimestamp: "2026-09-04T21:00:00.000Z",
              months: [{ month: "2026-03", status: "BACKFILLING", recordsRetrieved: 51, nextWindowFrom: "2026-03-15" }],
            },
          }),
        ],
        { mtdSales: 0, invoiceCount: 0, outstanding: 15, overdue: 0 },
      ),
      now: new Date("2026-09-04T21:00:00.000Z"),
    });
    expect(result.source?.checkpoint?.backfillCursor).toBe("2026-03-15");
    expect(result.source?.checkpoint?.historyFrom).toBe("2025-04-01");
    expect(await repo.getInvoice(WAREHOUSE_EL_COMPANY_ID, "INV-DUP")).toMatchObject({ total: 15 });
    expect((await repo.listInvoices(WAREHOUSE_EL_COMPANY_ID)).filter((row) => row.invoiceId === "INV-DUP")).toHaveLength(1);
    expect(result.source?.status).not.toBe("DEGRADED");
  });

  it("keeps warehouse sync off the EL 3p tariff and documents one completion email", () => {
    expect(warehouseTrafficClass()).toBe("AUTOMATION");
    expect(warehouseChildDebitCents()).toBe(0);
    const mail = warehouseBackfillCompleteEmail({
      source: {
        ...newWarehouseSource({ companyId: WAREHOUSE_EL_COMPANY_ID, connector: WAREHOUSE_XERO_CONNECTOR }),
        historicalFrom: "2025-04-01",
        historicalTo: "2026-09-04",
        recordCounts: { invoices: 400, invoiceLines: 0, contacts: 80, payments: 0, creditNotes: 0, snapshots: 10 },
        checkpoint: { mode: "incremental", completeness: "COMPLETE", completionEmailSent: false },
      },
      run: null,
      nextSync: "2026-09-05T06:00:00.000Z",
    });
    expect(mail.subject).toBe("INFRA — EL Xero Warehouse Historical Backfill Complete");
  });
});
