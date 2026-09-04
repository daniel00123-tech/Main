import { describe, expect, it } from "vitest";
import { clipBusinessToolData } from "./clip-tool-data";

describe("clipBusinessToolData catalogue", () => {
  it("keeps list_documents rows instead of truncating to a preview", () => {
    const documents = Array.from({ length: 8 }, (_, index) => ({
      id: `doc_${index}`,
      title: `File ${index}.pdf`,
      source: "onedrive",
      modifiedAt: "2026-09-01T12:00:00Z",
      createdAt: "2026-08-01T12:00:00Z",
      url: `https://elvex-my.sharepoint.com/personal/a/File${index}.pdf`,
      description: "x".repeat(800),
      descriptionSource: "indexed_content",
    }));
    const bulky = {
      status: "ok",
      code: "SUCCESS",
      source: "onedrive",
      dateField: "modified_at",
      dateFieldReason: "Sorted by last modified time.",
      count: documents.length,
      documents,
      message: "8 documents from the connected catalogue.",
    };
    expect(JSON.stringify(bulky).length).toBeGreaterThan(3_500);
    const clipped = clipBusinessToolData(bulky, "list_documents") as {
      documents: Array<{ title: string }>;
      status: string;
    };
    expect(clipped.status).toBe("ok");
    expect(clipped.documents.map((doc) => doc.title)).toContain("File 0.pdf");
    expect(clipped).not.toHaveProperty("truncated");
    expect(clipBusinessToolData(bulky).documents).toHaveLength(8);
  });

  it("keeps nested warehouse months instead of truncating the gateway wrapper", () => {
    const bulky = {
      correlationId: "c1",
      toolName: "warehouse_sales_analysis",
      result: {
        ok: true,
        evidence: { source: "xero_warehouse", warehouseAsOf: "2026-09-04T21:20:43.573Z", completenessStatus: "COMPLETE" },
        result: {
          months: [{ month: "2026-03", sales: 4120, invoiceCount: 18, completeness: "COMPLETE" }],
          fromDate: "2026-03-01",
          toDate: "2026-03-31",
          source: "xero_warehouse",
          warehouseAsOf: "2026-09-04T21:20:43.573Z",
          completenessStatus: "COMPLETE",
          padding: "x".repeat(4000),
        },
      },
    };
    const clipped = clipBusinessToolData(bulky, "warehouse_sales_analysis") as {
      months: Array<{ month: string; sales: number }>;
      source: string;
    };
    expect(clipped.source).toBe("xero_warehouse");
    expect(clipped.months[0]).toMatchObject({ month: "2026-03", sales: 4120 });
    expect(clipped).not.toHaveProperty("truncated");
  });
});
