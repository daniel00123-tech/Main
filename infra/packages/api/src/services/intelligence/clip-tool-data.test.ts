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
});
