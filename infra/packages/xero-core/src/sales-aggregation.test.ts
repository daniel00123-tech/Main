import { describe, expect, it } from "vitest";
import {
  aggregateSales,
  aggregateTopCustomers,
  classifySalesDocument,
  classifySalesDocuments,
} from "./sales-aggregation";

describe("sales aggregation", () => {
  it("includes ACCREC invoices in sales", () => {
    const doc = classifySalesDocument({
      documentKind: "invoice",
      documentNumber: "INV-001",
      transactionType: "ACCREC",
      status: "AUTHORISED",
      total: 1000,
      contactName: "Customer A",
    });
    expect(doc.qualifiesForSales).toBe(true);
    expect(doc.salesContribution).toBe(1000);
  });

  it("excludes ACCPAY purchase bills from sales", () => {
    const doc = classifySalesDocument({
      documentKind: "invoice",
      documentNumber: "BILL-001",
      transactionType: "ACCPAY",
      status: "AUTHORISED",
      total: 215.85,
      contactName: "No Contact",
    });
    expect(doc.qualifiesForSales).toBe(false);
    expect(doc.exclusionReason).toBe("purchase_invoice");
    expect(doc.salesContribution).toBe(0);
  });

  it("reduces sales for ACCRECCREDIT credit notes", () => {
    const doc = classifySalesDocument({
      documentKind: "credit_note",
      documentNumber: "CN-001",
      transactionType: "ACCRECCREDIT",
      status: "AUTHORISED",
      total: 200,
      contactName: "Customer A",
    });
    expect(doc.qualifiesForSales).toBe(true);
    expect(doc.salesContribution).toBe(-200);
  });

  it("excludes ACCPAYCREDIT purchase credit notes from sales", () => {
    const doc = classifySalesDocument({
      documentKind: "credit_note",
      documentNumber: "PCN-001",
      transactionType: "ACCPAYCREDIT",
      status: "AUTHORISED",
      total: 500,
      contactName: "Supplier",
    });
    expect(doc.qualifiesForSales).toBe(false);
    expect(doc.exclusionReason).toBe("purchase_credit_note");
  });

  it("excludes voided and deleted documents", () => {
    for (const status of ["VOIDED", "DELETED"] as const) {
      const doc = classifySalesDocument({
        documentKind: "invoice",
        transactionType: "ACCREC",
        status,
        total: 100,
      });
      expect(doc.qualifiesForSales).toBe(false);
      expect(doc.exclusionReason).toBe(`status_${status.toLowerCase()}`);
    }
  });

  it("aggregates only qualifying receivable sales", () => {
    const docs = classifySalesDocuments([
      {
        documentKind: "invoice",
        documentNumber: "INV-1",
        contactId: "contact-intuate",
        transactionType: "ACCREC",
        status: "PAID",
        total: 35000,
        contactName: "Intuate",
      },
      {
        documentKind: "invoice",
        documentNumber: "INV-2",
        contactId: "contact-elvex",
        transactionType: "ACCREC",
        status: "PAID",
        total: 8100,
        contactName: "ELVEX",
      },
      {
        documentKind: "invoice",
        documentNumber: "BILL-1",
        contactId: "contact-none",
        transactionType: "ACCPAY",
        status: "AUTHORISED",
        total: 215.85,
        contactName: "No Contact",
      },
      {
        documentKind: "credit_note",
        documentNumber: "CN-1",
        contactId: "contact-intuate",
        transactionType: "ACCRECCREDIT",
        status: "AUTHORISED",
        total: 100,
        contactName: "Intuate",
      },
    ]);
    const agg = aggregateSales(docs);
    expect(agg.totalSales).toBe(35000 + 8100 - 100);
    expect(agg.qualifyingTransactionCount).toBe(3);
    expect(agg.excludedTransactionCount).toBe(1);
    const top = aggregateTopCustomers(docs, 3);
    expect(top[0]?.name).toBe("Intuate");
    expect(top[0]?.total).toBe(34900);
    expect(top.some((row) => row.name === "No Contact")).toBe(false);
  });
});
