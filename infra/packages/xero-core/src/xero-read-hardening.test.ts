import { describe, expect, it } from "vitest";
import { classifyAgeingBucket, computeAgeingFromInvoices } from "./ageing";
import {
  compareIsoDateOnly,
  daysBetweenIso,
  isBeforeIsoDate,
  isOnOrAfterIsoDate,
  isOnOrBeforeIsoDate,
  normalizeXeroDate,
  resolveEffectiveDate,
} from "./dates";
import {
  filterInvoicesByType,
  formatInvoiceSummary,
  isOverdueSalesInvoice,
  normalizeInvoiceTypeFilter,
  sortOverdueInvoices,
} from "./invoices";
import { paginateInMemory } from "./pagination";
import {
  buildPaymentDateWhere,
  classifyPaymentDirection,
  filterPaymentsByDirection,
  filterPaymentsByTransactionDate,
  sumPaymentAmounts,
} from "./payments";
import {
  aggregateTopSuppliers,
  classifyPurchaseDocuments,
} from "./purchase-aggregation";
import {
  aggregateSales,
  aggregateTopCustomers,
  classifySalesDocuments,
  mapInvoiceRow,
} from "./sales-aggregation";

const EFFECTIVE = "2026-08-27";

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    Type: "ACCREC",
    Status: "AUTHORISED",
    AmountDue: 100,
    Total: 100,
    AmountPaid: 0,
    DueDate: "2026-08-26",
    Date: "2026-07-01",
    InvoiceNumber: "INV-001",
    InvoiceID: "inv-1",
    Contact: { Name: "Acme Ltd", ContactID: "c1" },
    ...overrides,
  };
}

function payment(overrides: Record<string, unknown> = {}) {
  return {
    PaymentID: "pay-1",
    Date: "2026-07-15",
    Amount: 500,
    Invoice: { Type: "ACCREC", InvoiceNumber: "INV-001", Contact: { Name: "Acme Ltd" } },
    ...overrides,
  };
}

describe("date normalisation", () => {
  it("parses Xero /Date(...)/ format", () => {
    expect(normalizeXeroDate("/Date(1785542400000)/")).toBe("2026-08-01");
  });

  it("passes through ISO dates", () => {
    expect(normalizeXeroDate("2026-07-31")).toBe("2026-07-31");
    expect(normalizeXeroDate("2026-07-31T12:00:00Z")).toBe("2026-07-31");
  });

  it("returns null for empty or malformed values", () => {
    expect(normalizeXeroDate(null)).toBeNull();
    expect(normalizeXeroDate("")).toBeNull();
    expect(normalizeXeroDate("not-a-date")).toBeNull();
  });

  it("compares ISO dates correctly", () => {
    expect(isBeforeIsoDate("2026-07-30", "2026-07-31")).toBe(true);
    expect(isBeforeIsoDate("2026-07-31", "2026-07-31")).toBe(false);
    expect(isOnOrAfterIsoDate("2026-07-01", "2026-07-01")).toBe(true);
    expect(isOnOrBeforeIsoDate("2026-07-31", "2026-07-31")).toBe(true);
    expect(compareIsoDateOnly("2026-08-01", "2026-07-31")).toBeGreaterThan(0);
  });

  it("computes days between dates", () => {
    expect(daysBetweenIso("2026-08-26", "2026-08-27")).toBe(1);
  });

  it("resolveEffectiveDate uses explicit date when provided", () => {
    expect(resolveEffectiveDate("2026-08-27")).toBe("2026-08-27");
  });
});

describe("overdue sales invoice logic", () => {
  it("due yesterday is overdue", () => {
    expect(isOverdueSalesInvoice(invoice({ DueDate: "2026-08-26" }), EFFECTIVE)).toBe(true);
  });

  it("due today is NOT overdue", () => {
    expect(isOverdueSalesInvoice(invoice({ DueDate: "2026-08-27" }), EFFECTIVE)).toBe(false);
  });

  it("due tomorrow is NOT overdue", () => {
    expect(isOverdueSalesInvoice(invoice({ DueDate: "2026-08-28" }), EFFECTIVE)).toBe(false);
  });

  it("future-due invoice (30 Sep 2026) is NOT overdue as at 27 Aug", () => {
    expect(isOverdueSalesInvoice(invoice({ DueDate: "2026-09-30" }), EFFECTIVE)).toBe(false);
  });

  it("partially paid overdue invoice is overdue", () => {
    expect(
      isOverdueSalesInvoice(
        invoice({ DueDate: "2026-08-01", AmountDue: 50, AmountPaid: 50, Total: 100 }),
        EFFECTIVE,
      ),
    ).toBe(true);
  });

  it("fully paid invoice is NOT overdue", () => {
    expect(
      isOverdueSalesInvoice(
        invoice({ DueDate: "2026-08-01", AmountDue: 0, AmountPaid: 100, Total: 100 }),
        EFFECTIVE,
      ),
    ).toBe(false);
  });

  it("ACCPAY supplier bill is excluded", () => {
    expect(isOverdueSalesInvoice(invoice({ Type: "ACCPAY" }), EFFECTIVE)).toBe(false);
  });

  it("draft is excluded", () => {
    expect(isOverdueSalesInvoice(invoice({ Status: "DRAFT" }), EFFECTIVE)).toBe(false);
  });

  it("voided is excluded", () => {
    expect(isOverdueSalesInvoice(invoice({ Status: "VOIDED" }), EFFECTIVE)).toBe(false);
  });

  it("deleted is excluded", () => {
    expect(isOverdueSalesInvoice(invoice({ Status: "DELETED" }), EFFECTIVE)).toBe(false);
  });

  it("sorts most overdue first", () => {
    const rows = sortOverdueInvoices([
      { daysOverdue: 5, dueDate: "2026-08-22" },
      { daysOverdue: 30, dueDate: "2026-07-28" },
      { daysOverdue: 10, dueDate: "2026-08-17" },
    ]);
    expect(rows.map((r) => r.daysOverdue)).toEqual([30, 10, 5]);
  });

  it("formatInvoiceSummary normalises /Date(...)/ and computes days overdue", () => {
    const summary = formatInvoiceSummary(
      invoice({
        DueDate: "/Date(1785196800000)/",
        Date: "/Date(1782864000000)/",
      }),
      EFFECTIVE,
    );
    expect(summary.dueDate).toBe("2026-07-28");
    expect(summary.invoiceDate).toBe("2026-07-01");
    expect(summary.daysOverdue).toBeGreaterThan(0);
    expect(summary.documentType).toBe("sales_invoice");
  });
});

describe("ACCREC / ACCPAY filtering", () => {
  const rows = [
    invoice({ Type: "ACCREC", InvoiceID: "1" }),
    invoice({ Type: "ACCPAY", InvoiceID: "2" }),
  ];

  it("ACCREC filter returns zero ACCPAY", () => {
    const filtered = filterInvoicesByType(rows, "ACCREC");
    expect(filtered.every((r) => r.Type === "ACCREC")).toBe(true);
    expect(filtered).toHaveLength(1);
  });

  it("ACCPAY filter returns zero ACCREC", () => {
    const filtered = filterInvoicesByType(rows, "ACCPAY");
    expect(filtered.every((r) => r.Type === "ACCPAY")).toBe(true);
    expect(filtered).toHaveLength(1);
  });

  it("ALL retains both types", () => {
    expect(filterInvoicesByType(rows, "ALL")).toHaveLength(2);
  });

  it("normalizes invoice type filter", () => {
    expect(normalizeInvoiceTypeFilter("accrec")).toBe("ACCREC");
    expect(normalizeInvoiceTypeFilter(undefined)).toBe("ALL");
  });
});

describe("payment date filtering", () => {
  const payments = [
    payment({ PaymentID: "p0", Date: "2026-06-30" }),
    payment({ PaymentID: "p1", Date: "2026-07-01" }),
    payment({ PaymentID: "p2", Date: "2026-07-31" }),
    payment({ PaymentID: "p3", Date: "2026-08-01" }),
    payment({
      PaymentID: "p4",
      Date: "2026-07-15",
      UpdatedDateUTC: "/Date(1785542400000)/",
    }),
  ];

  it("excludes 30 June", () => {
    const filtered = filterPaymentsByTransactionDate(payments, "2026-07-01", "2026-07-31");
    expect(filtered.find((p) => p.PaymentID === "p0")).toBeUndefined();
  });

  it("includes 1 July and 31 July", () => {
    const filtered = filterPaymentsByTransactionDate(payments, "2026-07-01", "2026-07-31");
    expect(filtered.find((p) => p.PaymentID === "p1")).toBeDefined();
    expect(filtered.find((p) => p.PaymentID === "p2")).toBeDefined();
  });

  it("excludes 1 August", () => {
    const filtered = filterPaymentsByTransactionDate(payments, "2026-07-01", "2026-07-31");
    expect(filtered.find((p) => p.PaymentID === "p3")).toBeUndefined();
  });

  it("August updated record with July payment date stays in July", () => {
    const filtered = filterPaymentsByTransactionDate(payments, "2026-07-01", "2026-07-31");
    expect(filtered.find((p) => p.PaymentID === "p4")).toBeDefined();
  });

  it("classifies customer receipt vs supplier payment", () => {
    expect(classifyPaymentDirection(payment())).toBe("customer_receipt");
    expect(
      classifyPaymentDirection(
        payment({ Invoice: { Type: "ACCPAY", InvoiceNumber: "BILL-001" } }),
      ),
    ).toBe("supplier_payment");
  });

  it("filters by direction", () => {
    const mixed = [
      payment({ PaymentID: "cr", Invoice: { Type: "ACCREC" } }),
      payment({ PaymentID: "sp", Invoice: { Type: "ACCPAY" } }),
    ];
    expect(filterPaymentsByDirection(mixed, "customer_receipt")).toHaveLength(1);
    expect(filterPaymentsByDirection(mixed, "supplier_payment")).toHaveLength(1);
  });

  it("sums payment amounts", () => {
    expect(sumPaymentAmounts([payment({ Amount: 100 }), payment({ Amount: 250 })])).toBe(350);
  });

  it("builds payment date WHERE clause", () => {
    expect(buildPaymentDateWhere("2026-07-01", "2026-07-31")).toContain("Date>=");
    expect(buildPaymentDateWhere("2026-07-01", "2026-07-31")).toContain("Date<=");
  });
});

describe("ageing buckets", () => {
  it("classifies current vs overdue buckets", () => {
    expect(classifyAgeingBucket("2026-09-01", EFFECTIVE)).toBe("current");
    expect(classifyAgeingBucket("2026-08-20", EFFECTIVE)).toBe("1-30");
    expect(classifyAgeingBucket("2026-07-01", EFFECTIVE)).toBe("31-60");
    expect(classifyAgeingBucket("2026-05-01", EFFECTIVE)).toBe("90+");
  });

  it("computes receivables ageing excluding ACCPAY", () => {
    const report = computeAgeingFromInvoices({
      invoices: [
        invoice({ Type: "ACCREC", AmountDue: 100, DueDate: "2026-08-01" }),
        invoice({ Type: "ACCPAY", AmountDue: 500, DueDate: "2026-08-01" }),
        invoice({ Type: "ACCREC", AmountDue: 200, DueDate: "2026-09-30", Status: "AUTHORISED" }),
      ],
      reportType: "receivables",
      effectiveDate: EFFECTIVE,
    });
    expect(report.reportType).toBe("receivables");
    expect(report.lines.every((l) => l.documentType === "sales_invoice")).toBe(true);
    expect(report.totalOutstanding).toBe(300);
    expect(report.buckets.find((b) => b.key === "current")?.totalAmountDue).toBe(200);
  });

  it("computes payables ageing excluding ACCREC", () => {
    const report = computeAgeingFromInvoices({
      invoices: [
        invoice({ Type: "ACCPAY", AmountDue: 35000, DueDate: "2026-09-15" }),
        invoice({ Type: "ACCREC", AmountDue: 100, DueDate: "2026-08-01" }),
      ],
      reportType: "payables",
      effectiveDate: EFFECTIVE,
    });
    expect(report.reportType).toBe("payables");
    expect(report.lines).toHaveLength(1);
    expect(report.lines[0].documentType).toBe("supplier_bill");
  });
});

describe("supplier ranking", () => {
  const docs = classifyPurchaseDocuments([
    {
      documentId: "b1",
      contactId: "s1",
      contactName: "Audit Co",
      transactionType: "ACCPAY",
      status: "AUTHORISED",
      total: 35000,
    },
    {
      documentId: "b2",
      contactId: "s1",
      contactName: "Audit Co",
      transactionType: "ACCPAY",
      status: "AUTHORISED",
      total: 239.74,
    },
    {
      documentId: "inv1",
      contactId: "c1",
      contactName: "Elvex",
      transactionType: "ACCREC",
      status: "AUTHORISED",
      total: 8100,
    },
  ]);

  it("ranks ACCPAY suppliers only", () => {
    const suppliers = aggregateTopSuppliers(docs, 5);
    expect(suppliers).toHaveLength(1);
    expect(suppliers[0].name).toBe("Audit Co");
    expect(suppliers[0].billCount).toBe(2);
    expect(suppliers[0].total).toBeCloseTo(35239.74);
    expect(suppliers[0].sharePercent).toBe(100);
  });
});

describe("sales semantics — invoice vs P&L", () => {
  it("ACCREC sales invoices aggregate separately from ACCPAY", () => {
    const raw = [
      mapInvoiceRow(
        invoice({ Total: 8100, Type: "ACCREC", Status: "AUTHORISED", InvoiceID: "i1" }),
      ),
      mapInvoiceRow(
        invoice({ Total: 100, Type: "ACCREC", Status: "AUTHORISED", InvoiceID: "i2" }),
      ),
      mapInvoiceRow(
        invoice({ Total: 35000, Type: "ACCPAY", Status: "AUTHORISED", InvoiceID: "b1" }),
      ),
    ];
    const aggregated = aggregateSales(classifySalesDocuments(raw));
    expect(aggregated.totalSales).toBe(8200);
    expect(aggregated.qualifyingTransactionCount).toBe(2);
    expect(aggregated.excludedTransactionCount).toBe(1);
  });

  it("top customers excludes supplier bills", () => {
    const raw = [
      mapInvoiceRow(
        invoice({
          Total: 8100,
          Type: "ACCREC",
          Contact: { Name: "Elvex Property Services Ltd", ContactID: "e1" },
        }),
      ),
      mapInvoiceRow(
        invoice({
          Total: 35000,
          Type: "ACCPAY",
          Contact: { Name: "Audit Co", ContactID: "s1" },
        }),
      ),
    ];
    const customers = aggregateTopCustomers(classifySalesDocuments(raw), 3);
    expect(customers).toHaveLength(1);
    expect(customers[0].name).toBe("Elvex Property Services Ltd");
    expect(customers[0].total).toBe(8100);
    expect(customers[0].transactionCount).toBe(1);
  });

  it("mapInvoiceRow normalises /Date(...)/ in dates", () => {
    const row = mapInvoiceRow(invoice({ Date: "/Date(1782864000000)/" }));
    expect(row.date).toBe("2026-07-01");
    expect(String(row.date)).not.toMatch(/^\/Date/);
  });
});

describe("pagination >100 records", () => {
  function makeInvoices(count: number) {
    return Array.from({ length: count }, (_, i) =>
      invoice({ InvoiceID: `inv-${i}`, Total: 100, Type: "ACCREC", Status: "AUTHORISED" }),
    );
  }

  it("fetches 101 records without silent truncation", () => {
    const all = makeInvoices(101);
    const { rows, meta } = paginateInMemory(all, 100, 500);
    expect(rows).toHaveLength(101);
    expect(meta.truncated).toBe(false);
    expect(meta.pagesFetched).toBe(2);
  });

  it("fetches 250 records and totals correctly", () => {
    const all = makeInvoices(250);
    const { rows, meta } = paginateInMemory(all, 100, 500);
    expect(rows).toHaveLength(250);
    expect(meta.truncated).toBe(false);
    const total = rows.reduce((sum, inv) => sum + Number(inv.Total ?? 0), 0);
    expect(total).toBe(25000);
    expect(meta.pagesFetched).toBe(3);
  });

  it("detects truncation at safety limit", () => {
    const all = makeInvoices(600);
    const { rows, meta } = paginateInMemory(all, 100, 500);
    expect(rows).toHaveLength(500);
    expect(meta.truncated).toBe(true);
  });

  it("has no duplicates across pages", () => {
    const all = makeInvoices(250);
    const { rows } = paginateInMemory(all, 100, 500);
    const ids = rows.map((r) => r.InvoiceID);
    expect(new Set(ids).size).toBe(250);
  });
});
